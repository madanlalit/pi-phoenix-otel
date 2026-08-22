/**
 * phoenix-otel.ts — pi → Arize Phoenix observability bridge (zero dependencies)
 *
 * Maps pi's extension events onto OpenTelemetry GenAI + OpenInference spans
 * and exports them via OTLP/HTTP (protobuf) directly to a Phoenix server.
 * The protobuf is hand-encoded — no npm dependencies required.
 *
 * Trace structure — configurable via "trace" in the config file:
 *   "session" (default): ONE trace per pi session
 *     pi.session                        (root, SESSION)
 *     ├── pi.run · <prompt snippet>     (one per user prompt)
 *     │   ├── pi.turn {n}               (LLM: tokens, cost, model)
 *     │   │   └── execute_tool <name>   (TOOL: arguments, result, errors)
 *     └── pi.run · …
 *   "run": one trace per user prompt (pi.run root + turns/tools)
 *
 * Configuration (in priority order):
 *   1. Environment variables:
 *        PHOENIX_OTEL_ENDPOINT     OTLP HTTP endpoint
 *                                  (default http://localhost:6006/v1/traces)
 *        PHOENIX_SERVICE_NAME      service.name resource attribute
 *                                  (default "pi-coding-agent")
 *        PHOENIX_PROJECT           Phoenix project name (default "pi")
 *        PHOENIX_CAPTURE_CONTENT=0 metadata only — no prompt/response/tool text
 *        PHOENIX_OTEL_ENABLED=0    disable the extension entirely
 *   2. Config file ~/.pi/agent/phoenix-otel.config.json:
 *        {
 *          "endpoint": "http://localhost:6006/v1/traces",
 *          "service": "pi-coding-agent",
 *          "project": "pi",
 *          "captureContent": true
 *        }
 *
 * Phoenix: https://github.com/Arize-ai/phoenix — run locally with
 *   uvx arize-phoenix serve   (or: pip install arize-phoenix && phoenix serve)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- configuration: env vars > user config file > defaults -----------------

interface OtelConfig {
	endpoint: string;
	service: string;
	project: string;
	captureContent: boolean;
	trace: "session" | "run";
}

function loadConfig(): OtelConfig {
	let file: Partial<OtelConfig> = {};
	const candidates = [
		path.join(os.homedir(), ".pi", "agent", "phoenix-otel.config.json"),
		path.join(process.cwd(), ".pi", "phoenix-otel.config.json"), // project-local override
	];
	for (const p of candidates) {
		try {
			file = JSON.parse(fs.readFileSync(p, "utf8"));
			break;
		} catch {
			// try next candidate
		}
	}
	return {
		endpoint: process.env.PHOENIX_OTEL_ENDPOINT ?? file.endpoint ?? "http://localhost:6006/v1/traces",
		service: process.env.PHOENIX_SERVICE_NAME ?? file.service ?? "pi-coding-agent",
		project: process.env.PHOENIX_PROJECT ?? file.project ?? "pi",
		captureContent:
			process.env.PHOENIX_CAPTURE_CONTENT === "0"
				? false
				: (file.captureContent ?? true),
		trace: (process.env.PHOENIX_TRACE as "session" | "run") ?? file.trace ?? "session",
	};
}

const CFG = loadConfig();
const ENDPOINT = CFG.endpoint;
const ENABLED = process.env.PHOENIX_OTEL_ENABLED !== "0";
const SERVICE = CFG.service;
const PROJECT = CFG.project;
const CAPTURE = CFG.captureContent;
const SESSION_TRACES = CFG.trace === "session";

const MAX_TEXT = 8192;
const MAX_TOOL_RESULT = 4096;

// --- Phoenix lifecycle helpers ---------------------------------------------

const PHOENIX_BASE = new URL(ENDPOINT).origin;
const LOG_FILE = path.join(os.tmpdir(), "pi-phoenix.log");

/** True if the Phoenix server answers on its base URL. */
async function phoenixUp(timeoutMs = 2500): Promise<boolean> {
	try {
		const res = await fetch(PHOENIX_BASE, { signal: AbortSignal.timeout(timeoutMs) });
		return res.status < 500;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Locate a usable uvx binary. */
function findUvx(): string | null {
	// Explicit override is exclusive — if set and unusable, report "not installed".
	if (process.env.PHOENIX_UVX_PATH) {
		try {
			fs.accessSync(process.env.PHOENIX_UVX_PATH, fs.constants.X_OK);
			return process.env.PHOENIX_UVX_PATH;
		} catch {
			return null;
		}
	}
	const candidates = [
		"/opt/homebrew/bin/uvx",
		"/usr/local/bin/uvx",
		path.join(os.homedir(), ".local/bin/uvx"),
	];
	for (const c of candidates) {
		if (!c) continue;
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return c;
		} catch {
			// keep looking
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Minimal protobuf encoder (OTLP wire format)
// ---------------------------------------------------------------------------

type Bytes = Uint8Array;

const varint = (n: bigint | number): Bytes => {
	let v = BigInt(n);
	const out: number[] = [];
	do {
		let b = Number(v & 0x7fn);
		v >>= 7n;
		if (v > 0n) b |= 0x80;
		out.push(b);
	} while (v > 0n);
	return new Uint8Array(out);
};

const tag = (field: number, wire: number): Bytes => varint((field << 3) | wire);
const concat = (...parts: Bytes[]): Bytes => {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};
const lenDelim = (field: number, data: Bytes): Bytes => concat(tag(field, 2), varint(data.length), data);
const vint = (field: number, value: bigint | number): Bytes => concat(tag(field, 0), varint(value));
const f64 = (field: number, value: bigint): Bytes => {
	const out = new Uint8Array(9);
	new DataView(out.buffer).setBigUint64(1, value, true);
	out[0] = (field << 3) | 1;
	return out;
};

// AnyValue: string_value=1, bool_value=2, int_value=3, double_value=4
const anyValue = (v: string | number | boolean): Bytes => {
	if (typeof v === "string") return lenDelim(1, new TextEncoder().encode(v));
	if (typeof v === "boolean") return vint(2, v ? 1 : 0);
	if (Number.isInteger(v)) return vint(3, v);
	const out = new Uint8Array(9);
	new DataView(out.buffer).setFloat64(1, v, true);
	out[0] = (4 << 3) | 1;
	return out;
};

const str = (field: number, s: string): Bytes => lenDelim(field, new TextEncoder().encode(s));

// KeyValue: key=1 (string), value=2 (AnyValue)
const keyValue = (k: string, v: string | number | boolean): Bytes =>
	concat(str(1, k), lenDelim(2, anyValue(v)));

interface Span {
	traceId: Bytes;
	spanId: Bytes;
	parentSpanId?: Bytes;
	name: string;
	startNs: bigint;
	endNs?: bigint;
	attributes: Record<string, string | number | boolean>;
}

// Span: trace_id=1, span_id=2, parent_span_id=4, name=5, kind=6,
//       start_time_unix_nano=7, end_time_unix_nano=8, attributes=9, status=15
const encodeSpan = (s: Span): Bytes => {
	const parts: Bytes[] = [
		lenDelim(1, s.traceId),
		lenDelim(2, s.spanId),
		str(5, s.name),
		vint(6, 1), // kind: INTERNAL
		f64(7, s.startNs),
	];
	if (s.parentSpanId) parts.push(lenDelim(4, s.parentSpanId));
	if (s.endNs !== undefined) parts.push(f64(8, s.endNs));
	for (const [k, v] of Object.entries(s.attributes)) {
		parts.push(lenDelim(9, keyValue(k, v)));
	}
	parts.push(lenDelim(15, vint(3, 1))); // Status { code: OK }
	return concat(...parts);
};

// InstrumentationScope: name=1, version=2
const scope = lenDelim(
	1,
	concat(str(1, "pi.extension.phoenix-otel"), str(2, "0.1.0")),
);

// ResourceSpans: resource=1 → ScopeSpans: scope=1, spans=2
const encodeBatch = (spans: Span[]): Bytes => {
	const encoded = spans.map((s) => lenDelim(2, encodeSpan(s)));
	const scopeSpans = lenDelim(2, concat(scope, ...encoded));
	// Resource message body = repeated KeyValue attributes (field 1)
	const resourceBody = concat(
		lenDelim(1, keyValue("service.name", SERVICE)),
		lenDelim(1, keyValue("gen_ai.system", "pi")),
		lenDelim(1, keyValue("openinference.project.name", PROJECT)),
	);
	// ExportTraceServiceRequest.resource_spans=1 → ResourceSpans{resource=1, scope_spans=2}
	return lenDelim(1, concat(lenDelim(1, resourceBody), scopeSpans));
};

// ---------------------------------------------------------------------------
// Extension logic
// ---------------------------------------------------------------------------

const hexBytes = (n: number): Bytes => new Uint8Array(crypto.randomBytes(n));
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

const textOf = (m: Record<string, any>): string => {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("");
};

export default function (pi: ExtensionAPI) {
	if (!ENABLED) return;

	let sessionId = "";
	let sessionPath = "";
	let cwd = "";

	// per-run state
	let rootSpan: Span | null = null;
	let currentTurnSpan: Span | null = null;
	let runInputs: string[] = [];
	let runOutputs: string[] = [];
	let runImages = 0;
	const openTools = new Map<string, Span>();
	const buffer: Span[] = [];
	let sessionRoot: Span | null = null;
	let runCount = 0;

	async function flush() {
		if (buffer.length === 0) return;
		const batch = buffer.splice(0, buffer.length);
		try {
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/x-protobuf" },
				body: encodeBatch(batch) as unknown as BodyInit,
			});
			if (!res.ok) console.error(`[phoenix-otel] export failed: ${res.status}`);
		} catch {
			// Phoenix unreachable — never break the agent loop.
		}
	}

	function close(span: Span, extraAttrs: Span["attributes"] = {}) {
		span.endNs = nowNs();
		Object.assign(span.attributes, extraAttrs);
		buffer.push(span);
	}

	function extractUsage(m: Record<string, any>) {
		const usage = m.usage ?? {};
		const attrs: Span["attributes"] = {};
		if (usage.input?.tokens != null) attrs["gen_ai.usage.input_tokens"] = usage.input.tokens;
		if (usage.output?.tokens != null) attrs["gen_ai.usage.output_tokens"] = usage.output.tokens;
		if (usage.cacheRead?.tokens != null)
			attrs["gen_ai.usage.cache_read_input_tokens"] = usage.cacheRead.tokens;
		if (usage.cacheWrite?.tokens != null)
			attrs["gen_ai.usage.cache_write_input_tokens"] = usage.cacheWrite.tokens;
		if (usage.cost?.total != null) attrs["gen_ai.usage.cost"] = usage.cost.total;
		return attrs;
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionId = (ctx as any).sessionManager?.sessionId ?? hexBytes(8).toString("hex");
		sessionPath = (ctx as any).sessionManager?.sessionFile ?? (ctx as any).sessionManager?.path ?? "";
		cwd = ctx.cwd;
	});

	// Capture every user input, including steers & queued follow-ups mid-run
	// (kept even when captureContent=false: needed for span naming; content is
	// only written into attributes under CAPTURE)
	pi.on("input", async (event) => {
		runInputs.push(trunc(event.text ?? "", MAX_TEXT));
		runImages += event.images?.length ?? 0;
	});

	pi.on("agent_start", async (_event, ctx) => {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
		const first = runInputs[0] ?? "(no text)";
		const snippet = trunc(first.replace(/\s+/g, " ").trim(), 48);

		if (SESSION_TRACES && !sessionRoot) {
			// Lazily create the session root so the trace exists from the first
			// run; it stays open until session_shutdown.
			sessionRoot = {
				traceId: hexBytes(16),
				spanId: hexBytes(8),
				name: `pi.session · ${trunc(path.basename(cwd || "~"), 40)}`,
				startNs: nowNs(),
				attributes: {
					"session.id": sessionId,
					"session.path": trunc(sessionPath, 512),
					"cwd": cwd,
					"gen_ai.system": "pi",
					"openinference.span.kind": "SESSION",
				},
			};
		}

		const parent = SESSION_TRACES ? sessionRoot : null;
		rootSpan = {
			traceId: parent ? parent.traceId : hexBytes(16),
			spanId: hexBytes(8),
			parentSpanId: parent?.spanId,
			name: SESSION_TRACES
				? `pi.run ${++runCount} · ${snippet}${first.length > 48 ? "…" : ""}`
				: `pi.run · ${snippet}${first.length > 48 ? "…" : ""}`,
			startNs: nowNs(),
				attributes: {
				"gen_ai.system": "pi",
				"gen_ai.request.model": model,
				"openinference.span.kind": "AGENT",
				"input.value": CAPTURE ? trunc(runInputs.join("\n---\n"), MAX_TEXT) : "(redacted)",
				"input.images": runImages,
				"output.value": "",
			},
		};
	});

	pi.on("turn_start", async (event) => {
		if (!rootSpan) return;
		currentTurnSpan = {
			traceId: rootSpan.traceId,
			spanId: hexBytes(8),
			parentSpanId: rootSpan.spanId,
			name: `pi.turn ${event.turnIndex}`,
			startNs: nowNs(),
			attributes: {
				"openinference.span.kind": "LLM",
				// Give each LLM turn its Input panel (the run's prompt)
				...(CAPTURE && rootSpan.attributes["input.value"]
					? { "input.value": String(rootSpan.attributes["input.value"]) }
					: {}),
			},
		};
	});

	pi.on("message_end", async (event) => {
		const m = event.message as Record<string, any>;
		if (m?.role !== "assistant") return;
		const target = currentTurnSpan ?? rootSpan;
		if (!target) return;

		Object.assign(target.attributes, extractUsage(m));
		if (m.model) target.attributes["gen_ai.response.model"] = m.model;

		const text = textOf(m);
		if (text) {
			if (CAPTURE) {
				target.attributes["output.value"] = trunc(text, MAX_TEXT);
				runOutputs.push(text);
			}
			const think = Array.isArray(m.content)
				? m.content
						.filter((b: any) => b?.type === "thinking")
						.map((b: any) => b.thinking ?? b.text ?? "")
						.join("")
				: "";
			if (think) target.attributes["reasoning.char_count"] = think.length;
		}
	});

	pi.on("tool_execution_start", async (event) => {
		const parent = currentTurnSpan ?? rootSpan;
		if (!parent) return;
		openTools.set(event.toolCallId, {
			traceId: parent.traceId,
			spanId: hexBytes(8),
			parentSpanId: parent.spanId,
			name: `execute_tool ${event.toolName}`,
			startNs: nowNs(),
			attributes: {
				"openinference.span.kind": "TOOL",
				"gen_ai.tool.name": event.toolName,
				"gen_ai.tool.call.id": event.toolCallId,
				...(CAPTURE ? { "tool.arguments": trunc(JSON.stringify(event.args ?? {}), MAX_TOOL_RESULT) } : {}),
			},
		});
	});

	pi.on("tool_execution_end", async (event) => {
		const span = openTools.get(event.toolCallId);
		if (!span) return;
		openTools.delete(event.toolCallId);
		const resultText = CAPTURE
			? textOf((event.result ?? {}) as Record<string, any>) || JSON.stringify(event.result ?? "")
			: "(redacted)";
		close(span, {
			"tool.is_error": !!event.isError,
			"output.value": trunc(resultText, MAX_TOOL_RESULT),
		});
	});

	pi.on("turn_end", async () => {
		if (currentTurnSpan) {
			close(currentTurnSpan);
			currentTurnSpan = null;
		}
	});

	pi.on("agent_end", async () => {
		for (const [, span] of openTools) close(span, { "tool.is_error": true });
		openTools.clear();
		if (currentTurnSpan) {
			close(currentTurnSpan);
			currentTurnSpan = null;
		}
		if (rootSpan) {
			if (CAPTURE) rootSpan.attributes["output.value"] = trunc(runOutputs.join("\n\n"), MAX_TEXT);
			close(rootSpan);
			rootSpan = null;
		}
		runInputs = [];
		runOutputs = [];
		runImages = 0;
		await flush();
	});

	pi.on("session_shutdown", async () => {
		if (sessionRoot) {
			close(sessionRoot, { "session.run_count": runCount });
			sessionRoot = null;
		}
		runCount = 0;
		await flush();
	});

	pi.registerCommand("otel-flush", {
		description: "Flush pending OTLP spans to Phoenix",
		handler: async (_args, ctx) => {
			await flush();
			ctx.ui.notify(`Phoenix OTel: flushed → ${ENDPOINT}`, "info");
		},
	});

	pi.registerCommand("otel-status", {
		description: "Show Phoenix OTel configuration and server status",
		handler: async (_args, ctx) => {
			const up = await phoenixUp();
			ctx.ui.notify(
				`Phoenix OTel — server: ${up ? "running" : "down"} (${PHOENIX_BASE}) · project: "${PROJECT}" · service: "${SERVICE}" · content: ${CAPTURE ? "on" : "off"} · traces/session: ${SESSION_TRACES ? "session" : "run"}`,
				up ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("otel-start", {
		description: "Start Arize Phoenix in the background via uvx",
		handler: async (_args, ctx) => {
			if (await phoenixUp()) {
				ctx.ui.notify(`Phoenix is already running at ${PHOENIX_BASE}`, "info");
				return;
			}

			const uvx = findUvx();
			if (!uvx) {
				ctx.ui.notify(
					`Cannot start Phoenix: uv is not installed (looked for uvx). Install it with:\n  brew install uv\nThen run /otel-start again. Alternatively start Phoenix manually and open ${PHOENIX_BASE}.`,
					"error",
				);
				return;
			}

			const logFd = fs.openSync(LOG_FILE, "a");
			let child;
			try {
				// Detached: Phoenix keeps running after pi exits. Output goes to a log file.
				child = spawn(uvx, ["arize-phoenix", "serve"], {
					detached: true,
					stdio: ["ignore", logFd, logFd],
				});
			} catch (err) {
				ctx.ui.notify(`Failed to spawn uvx: ${String(err)}`, "error");
				return;
			}
			child.unref();

			ctx.ui.notify(
				`Starting Phoenix via ${uvx} (first run downloads packages; logs: ${LOG_FILE})…`,
				"info",
			);

			// Poll until healthy (generous timeout for cold starts).
			for (let i = 0; i < 60; i++) {
				await sleep(2000);
				if (await phoenixUp()) {
					ctx.ui.notify(`Phoenix is up → ${PHOENIX_BASE}`, "info");
					return;
				}
				// Process died (port conflict, bad install, …) — fail fast.
				if (child.exitCode !== null || child.signalCode !== null) {
					ctx.ui.notify(
						`Phoenix exited immediately (code ${child.exitCode ?? child.signalCode}) — check ${LOG_FILE}. Is another instance already on port ${new URL(PHOENIX_BASE).port || "6006"}?`,
						"error",
					);
					return;
				}
			}
			ctx.ui.notify(
				`Phoenix did not come up within 2 minutes — check ${LOG_FILE}`,
				"warning",
			);
		},
	});
}
