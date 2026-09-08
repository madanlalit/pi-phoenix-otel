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
 *     │   ├── pi.turn {n}               (LLM: tokens, cost, model, finish reason)
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
 *        PHOENIX_API_KEY           Bearer token for Phoenix Cloud / auth proxies
 *        PHOENIX_CAPTURE_CONTENT=0 metadata only — no prompt/response/tool text
 *        PHOENIX_OTEL_ENABLED=0    disable the extension entirely
 *   2. Config file ~/.pi/agent/phoenix-otel.config.json:
 *        {
 *          "endpoint": "http://localhost:6006/v1/traces",
 *          "service": "pi-coding-agent",
 *          "project": "pi",
 *          "apiKey": "",
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
	apiKey?: string;
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
		apiKey: process.env.PHOENIX_API_KEY ?? file.apiKey ?? undefined,
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
const API_KEY = CFG.apiKey;
const CAPTURE = CFG.captureContent;
const SESSION_TRACES = CFG.trace === "session";
const EXT_VERSION = "0.2.0";

const MAX_TEXT = 8192; // bytes
const MAX_TOOL_RESULT = 4096; // bytes
const MAX_PARAMS = 2048; // bytes
const MAX_SYSTEM_PROMPT = 4096; // bytes

// --- text utilities (UTF-8 / ANSI safe) -------------------------------------

const UTF8 = new TextEncoder();

/** Truncate a string to at most maxBytes of UTF-8 without splitting code points. */
function trunc(s: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let bytes = 0;
	for (let i = 0; i < s.length; i++) {
		const cp = s.codePointAt(i)!;
		const w = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
		if (bytes + w > maxBytes) return s.slice(0, i);
		bytes += w;
		if (cp > 0xffff) i++; // skip low surrogate
	}
	return s;
}

/** Collapse whitespace and truncate — for span names. */
function preview(s: string, maxBytes: number): string {
	return trunc(s.replace(/\s+/g, " ").trim(), maxBytes);
}

// strip-ansi pattern (MIT) + OSC sequences — terminal formatting never belongs in traces
const ANSI_RE =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function clean(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** JSON.stringify with circular-reference protection; returns undefined on failure. */
function safeJson(value: unknown, maxBytes: number): string | undefined {
	const seen = new WeakSet<object>();
	try {
		const out = JSON.stringify(value, (_k, v: unknown) => {
			if (typeof v !== "object" || v === null) return v;
			if (seen.has(v as object)) return "[Circular]";
			seen.add(v as object);
			return v;
		});
		return out === undefined ? undefined : trunc(out, maxBytes);
	} catch {
		return undefined;
	}
}

/** Pick a short, human-friendly span name for a tool call. */
function toolSpanName(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	if (typeof a.command === "string") return `${name}: ${preview(a.command, 60)}`;
	if (typeof a.path === "string") return `${name} ${a.path}`;
	if (typeof a.file_path === "string") return `${name} ${a.file_path}`;
	if (typeof a.pattern === "string") return `${name}: ${preview(a.pattern, 40)}`;
	return name;
}

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
	if (typeof v === "string") return lenDelim(1, UTF8.encode(v));
	if (typeof v === "boolean") return vint(2, v ? 1 : 0);
	if (Number.isInteger(v)) return vint(3, v);
	const out = new Uint8Array(9);
	new DataView(out.buffer).setFloat64(1, v, true);
	out[0] = (4 << 3) | 1;
	return out;
};

const str = (field: number, s: string): Bytes => lenDelim(field, UTF8.encode(s));

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
	concat(str(1, "pi.extension.phoenix-otel"), str(2, EXT_VERSION)),
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

const textOf = (m: Record<string, any>): string => {
	const c = m.content;
	if (typeof c === "string") return clean(c);
	if (!Array.isArray(c)) return "";
	return c
		.filter((b: any) => b?.type === "text")
		.map((b: any) => clean(b.text ?? ""))
		.join("");
};

/** pi's Usage shape is flat ({ input, output, cacheRead, … }); older builds
 *  nested token counts ({ input: { tokens } }). Support both defensively. */
const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) ? v : undefined;

function extractUsage(m: Record<string, any>): Span["attributes"] {
	const u = (m.usage ?? {}) as Record<string, any>;
	const attrs: Span["attributes"] = {};
	const input = num(u.input) ?? num(u.input?.tokens);
	const output = num(u.output) ?? num(u.output?.tokens);
	const cacheRead = num(u.cacheRead) ?? num(u.cacheRead?.tokens);
	const cacheWrite = num(u.cacheWrite) ?? num(u.cacheWrite?.tokens);
	const reasoning = num(u.reasoning);
	const cost = (u.cost ?? {}) as Record<string, unknown>;

	if (input != null) attrs["gen_ai.usage.input_tokens"] = input;
	if (output != null) attrs["gen_ai.usage.output_tokens"] = output;
	if (cacheRead != null) attrs["gen_ai.usage.cache_read_input_tokens"] = cacheRead;
	if (cacheWrite != null) attrs["gen_ai.usage.cache_write_input_tokens"] = cacheWrite;
	if (reasoning != null) attrs["gen_ai.usage.reasoning_tokens"] = reasoning;

	const total = num(cost.total);
	if (total != null) attrs["gen_ai.usage.cost"] = total;
	const costInput = num(cost.input);
	const costCacheRead = num(cost.cacheRead);
	const costCacheWrite = num(cost.cacheWrite);
	const costOutput = num(cost.output);
	if (costInput != null || costCacheRead != null || costCacheWrite != null) {
		attrs["gen_ai.usage.cost.prompt"] =
			(costInput ?? 0) + (costCacheRead ?? 0) + (costCacheWrite ?? 0);
	}
	if (costOutput != null) attrs["gen_ai.usage.cost.completion"] = costOutput;
	if (costInput != null) attrs["gen_ai.usage.cost.input"] = costInput;
	if (costCacheRead != null) attrs["gen_ai.usage.cost.cache_read"] = costCacheRead;
	if (costCacheWrite != null) attrs["gen_ai.usage.cost.cache_write"] = costCacheWrite;
	return attrs;
}

/** Invocation parameters (temperature, max_tokens, …) from the raw provider payload. */
function extractParams(payload: unknown): { params?: string; toolsCount?: number } {
	if (!payload || typeof payload !== "object") return {};
	const p = payload as Record<string, unknown>;
	const kept: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(p)) {
		if (k === "messages" || k === "input" || k === "tools" || k === "system") continue;
		kept[k] = v;
	}
	const toolsCount = Array.isArray(p.tools) ? p.tools.length : undefined;
	const params = Object.keys(kept).length > 0 ? safeJson(kept, MAX_PARAMS) : undefined;
	return { params, toolsCount };
}

/** OSC-8 terminal hyperlink; terminals that don't support it just show the label. */
function hyperlink(label: string, url: string): string {
	return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

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
	let systemPrompt: string | undefined;
	let lastParams: string | undefined;
	let lastToolsCount: number | undefined;
	const openTools = new Map<string, Span>();
	const buffer: Span[] = [];
	let sessionRoot: Span | null = null;
	let runCount = 0;
	let statusCtx: { hasUI: boolean; ui: any } | null = null;

	function setStatusLink(ui: any, hasUI: boolean) {
		if (!hasUI || !ui || !sessionId) return;
		const url = `${PHOENIX_BASE}/redirects/sessions/${encodeURIComponent(sessionId)}`;
		try {
			ui.setStatus("phoenix-otel", hyperlink("phoenix ↗", url));
		} catch {
			// status API unavailable — not fatal
		}
	}

	async function flush() {
		if (buffer.length === 0) return;
		const batch = buffer.splice(0, buffer.length);
		const body = encodeBatch(batch);
		const headers: Record<string, string> = { "Content-Type": "application/x-protobuf" };
		if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
		// One retry, then drop — Phoenix unreachable must never break the agent loop.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await fetch(ENDPOINT, {
					method: "POST",
					headers,
					body: body as unknown as BodyInit,
				});
				if (res.ok) return true;
				if (res.status >= 400 && res.status < 500) break; // don't retry client errors
			} catch {
				// network error — fall through to retry
			}
			if (attempt === 0) await sleep(1000);
		}
		console.error(`[phoenix-otel] export failed after retry: ${ENDPOINT}`);
		return false;
	}

	function close(span: Span, extraAttrs: Span["attributes"] = {}) {
		span.endNs = nowNs();
		Object.assign(span.attributes, extraAttrs);
		buffer.push(span);
	}

	pi.on("session_start", async (_event, ctx) => {
		const sm = (ctx as any).sessionManager;
		sessionId =
			(typeof sm?.getSessionId === "function" ? sm.getSessionId() : undefined) ??
			sm?.sessionId ??
			crypto.randomBytes(8).toString("hex");
		sessionPath =
			(typeof sm?.getSessionFile === "function" ? sm.getSessionFile() : undefined) ??
			sm?.sessionFile ??
			sm?.path ??
			"";
		cwd = ctx.cwd;
	});

	// Capture every user input, including steers & queued follow-ups mid-run
	// (kept even when captureContent=false: needed for span naming; content is
	// only written into attributes under CAPTURE)
	pi.on("input", async (event) => {
		runInputs.push(trunc(clean(event.text ?? ""), MAX_TEXT));
		runImages += event.images?.length ?? 0;
	});

	pi.on("before_agent_start", async (event) => {
		// Fully assembled system prompt for this run (content-gated).
		systemPrompt = CAPTURE && event.systemPrompt ? trunc(clean(event.systemPrompt), MAX_SYSTEM_PROMPT) : undefined;
	});

	pi.on("before_provider_request", async (event) => {
		// Raw provider payload — keep only invocation parameters (temperature,
		// max_tokens, …), gated by captureContent since payloads vary by provider.
		// Messages/tools are excluded; tool count kept as pure metadata.
		const { params, toolsCount } = extractParams(event.payload);
		if (CAPTURE && params) lastParams = params;
		if (toolsCount != null) lastToolsCount = toolsCount;
	});

	pi.on("agent_start", async (_event, ctx) => {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
		const first = runInputs[0] ?? "(no text)";
		const snippet = preview(first, 48);
		statusCtx = { hasUI: (ctx as any).hasUI, ui: (ctx as any).ui };

		if (SESSION_TRACES && !sessionRoot) {
			// Lazily create the session root so the trace exists from the first
			// run; it stays open until session_shutdown.
			sessionRoot = {
				traceId: hexBytes(16),
				spanId: hexBytes(8),
				name: `pi.session · ${preview(path.basename(cwd || "~"), 40)}`,
				startNs: nowNs(),
				attributes: {
					"session.id": sessionId,
					"session.path": trunc(sessionPath, 512),
					cwd: cwd,
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
				...(systemPrompt ? { "gen_ai.prompt.system": systemPrompt } : {}),
			},
		};
	});

	pi.on("message_end", async (event) => {
		const m = event.message as Record<string, any>;
		if (m?.role !== "assistant") return;
		const target = currentTurnSpan ?? rootSpan;
		if (!target) return;

		Object.assign(target.attributes, extractUsage(m));
		if (lastParams) target.attributes["llm.invocation_parameters"] = lastParams;
		if (lastToolsCount != null) target.attributes["gen_ai.request.tools_count"] = lastToolsCount;
		if (m.responseModel || m.model) {
			target.attributes["gen_ai.response.model"] = m.responseModel ?? m.model;
		}
		if (m.stopReason) target.attributes["gen_ai.response.finish_reason"] = m.stopReason;

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
			name: toolSpanName(event.toolName, event.args),
			startNs: nowNs(),
			attributes: {
				"openinference.span.kind": "TOOL",
				"gen_ai.tool.name": event.toolName,
				"gen_ai.tool.call.id": event.toolCallId,
				...(CAPTURE
					? { "tool.arguments": trunc(safeJson(event.args ?? {}, MAX_TOOL_RESULT) ?? "{}", MAX_TOOL_RESULT) }
					: {}),
			},
		});
	});

	pi.on("tool_execution_end", async (event) => {
		const span = openTools.get(event.toolCallId);
		if (!span) return;
		openTools.delete(event.toolCallId);
		const resultText = CAPTURE
			? trunc(clean(textOf((event.result ?? {}) as Record<string, any>)) || clean(JSON.stringify(event.result ?? "")), MAX_TOOL_RESULT)
			: "(redacted)";
		close(span, {
			"tool.is_error": !!event.isError,
			"output.value": resultText,
		});
	});

	pi.on("turn_end", async () => {
		if (currentTurnSpan) {
			close(currentTurnSpan);
			currentTurnSpan = null;
		}
		lastParams = undefined;
		lastToolsCount = undefined;
		// Checkpoint after each turn — a crash mid-run loses at most one turn.
		await flush();
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
		systemPrompt = undefined;
		await flush();
		// Trace is now queryable — surface a clickable link to the session.
		setStatusLink(statusCtx?.ui, statusCtx?.hasUI ?? false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (sessionRoot) {
			close(sessionRoot, { "session.run_count": runCount });
			sessionRoot = null;
		}
		runCount = 0;
		await flush();
		if ((ctx as any).hasUI) {
			try {
				(ctx as any).ui.setStatus("phoenix-otel", undefined);
			} catch {
				// status API unavailable — not fatal
			}
		}
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
				`Phoenix OTel — server: ${up ? "running" : "down"} (${PHOENIX_BASE}) · project: "${PROJECT}" · service: "${SERVICE}" · content: ${CAPTURE ? "on" : "off"} · traces/session: ${SESSION_TRACES ? "session" : "run"} · auth: ${API_KEY ? "bearer" : "none"}${sessionId ? ` · session: ${sessionId.slice(0, 8)}…` : ""}`,
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
