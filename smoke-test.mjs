import { createServer } from "node:http";

let posted = [];
const srv = createServer((req, res) => {
	let chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		posted.push(Buffer.concat(chunks));
		res.writeHead(200).end();
	});
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
process.env.PHOENIX_OTEL_ENDPOINT = `http://127.0.0.1:${port}/v1/traces`;
process.env.PHOENIX_CAPTURE_CONTENT = "1";

const { default: extension } = await import("./extensions/phoenix-otel.ts");

// --- decode helpers ---------------------------------------------------------
function readVarint(b, o) {
	let v = 0n, s = 0n;
	for (;;) {
		v |= BigInt(b[o] & 0x7f) << s;
		if (!(b[o] & 0x80)) return [v, o + 1];
		o++; s += 7n;
	}
}
function fields(b) {
	const out = []; let o = 0;
	while (o < b.length) {
		const [tag, o1] = readVarint(b, o);
		const f = Number(tag >> 3n), w = Number(tag & 7n); let v;
		if (w === 2) { const [l, o2] = readVarint(b, o1); v = b.subarray(o2, o2 + Number(l)); o = o2 + Number(l); }
		else if (w === 0) { const [x, o2] = readVarint(b, o1); v = x; o = o2; }
		else if (w === 1) { v = b.subarray(o1, o1 + 8); o = o1 + 8; }
		else if (w === 5) { v = b.subarray(o1, o1 + 4); o = o1 + 4; }
		else throw new Error(`wire ${w}`);
		out.push([f, w, v]);
	}
	return out;
}
function decodeValue(v) {
	for (const [f, w, val] of fields(v)) {
		if (f === 1) return ["str", val.toString("utf8")];
		if (f === 2) return ["bool", Number(val) === 1];
		if (f === 3) return ["int", Number(val)];
		if (f === 4) return ["dbl", new DataView(val.buffer, val.byteOffset).getFloat64(0, true)];
	}
}
function decodeSpan(b) {
	const s = { attrs: {} };
	for (const [f, , v] of fields(b)) {
		if (f === 5) s.name = v.toString("utf8");
		if (f === 9) {
			let k, val;
			for (const [kf, , kv] of fields(v)) {
				if (kf === 1) k = kv.toString("utf8");
				if (kf === 2) val = decodeValue(kv);
			}
			s.attrs[k] = val;
		}
	}
	return s;
}

// --- mock pi -----------------------------------------------------------------
const handlers = {};
const pi = {
	on: (ev, h) => (handlers[ev] ??= []).push(h),
	registerCommand: () => {},
};
extension(pi);

const ctx = {
	cwd: "/tmp/demo-repo",
	hasUI: false,
	model: { provider: "anthropic", id: "claude-smoke" },
	sessionManager: {
		getSessionId: () => "sess-1234-abcd",
		getSessionFile: () => "/tmp/.pi/sessions/sess-1234.jsonl",
	},
};
const fire = async (ev, event, c = ctx) => {
	for (const h of handlers[ev] ?? []) await h(event, c);
};

await fire("session_start", { reason: "new" });
await fire("input", { text: "fix the login bug", images: [] });
await fire("before_agent_start", { prompt: "fix the login bug", systemPrompt: "You are pi.\x1b[31m red" });
await fire("agent_start", {});
await fire("turn_start", { turnIndex: 0 });
await fire("before_provider_request", { payload: { temperature: 0.7, max_tokens: 512, messages: [{ role: "user" }], tools: [{}, {}, {}] } });
await fire("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls -la\ngrep foo" } });
await fire("tool_execution_end", { toolCallId: "t1", result: { content: [{ type: "text", text: "total 0\x1b[32m" }] }, isError: false });
await fire("message_end", {
	message: {
		role: "assistant", model: "claude-smoke", provider: "anthropic", stopReason: "toolUse",
		content: [{ type: "text", text: "looking at files" }],
		usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 16, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 } },
	},
});
await fire("turn_end", {});
await fire("agent_end", {});
await fire("session_shutdown", {}, { hasUI: false });
srv.close();

// --- assertions --------------------------------------------------------------
if (posted.length === 0) throw new Error("no POST captured");
const all = [];
for (const buf of posted) {
	for (const [, , rs] of fields(buf).filter(([f]) => f === 1)) {
		for (const [, , ss] of fields(rs).filter(([f]) => f === 2)) {
			for (const [, , sp] of fields(ss).filter(([f]) => f === 2)) all.push(decodeSpan(sp));
		}
	}
}
const names = all.map((s) => s.name);
const A = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };
const get = (name, key) => all.find((s) => s.name === name)?.attrs?.[key];

A(names.some((n) => n.startsWith("pi.session")), `session span (${names.join(" | ")})`);
A(names.includes("pi.run 1 · fix the login bug"), "run span name");
A(names.includes("pi.turn 0"), "turn span name");
A(names.includes("bash: ls -la grep foo"), "smart tool span name");

A(get("pi.turn 0", "gen_ai.usage.input_tokens")?.[1] === 10, "input tokens (flat Usage fix)");
A(get("pi.turn 0", "gen_ai.usage.cache_read_input_tokens")?.[1] === 2, "cache read tokens");
A(get("pi.turn 0", "gen_ai.usage.reasoning_tokens")?.[1] === 3, "reasoning tokens");
A(Math.abs(get("pi.turn 0", "gen_ai.usage.cost")?.[1] - 0.033) < 1e-9, "cost total");
A(Math.abs(get("pi.turn 0", "gen_ai.usage.cost.prompt")?.[1] - 0.013) < 1e-9, "cost prompt = input+cacheRead+cacheWrite");
A(get("pi.turn 0", "gen_ai.usage.cost.completion")?.[1] === 0.02, "cost completion");
A(get("pi.turn 0", "gen_ai.response.finish_reason")?.[1] === "toolUse", "finish reason");
A(get("pi.turn 0", "gen_ai.response.model")?.[1] === "claude-smoke", "response model");
A(get("pi.turn 0", "gen_ai.prompt.system")?.[1] === "You are pi. red", "system prompt captured + ANSI stripped");
const inv = get("pi.turn 0", "llm.invocation_parameters")?.[1] ?? "";
A(inv.includes("temperature") && inv.includes("max_tokens") && !inv.includes("messages"), "invocation params w/o messages");
A(get("pi.turn 0", "gen_ai.request.tools_count")?.[1] === 3, "tools count");
A(get("bash: ls -la grep foo", "output.value")?.[1] === "total 0", "tool output ANSI-stripped");
A(get("bash: ls -la grep foo", "tool.is_error")?.[1] === false, "tool not error");
A(get("pi.session · demo-repo", "session.id")?.[1] === "sess-1234-abcd", "session.id from getSessionId()");
A(get("pi.session · demo-repo", "session.path")?.[1] === "/tmp/.pi/sessions/sess-1234.jsonl", "session.path from getSessionFile()");

console.log(process.exitCode ? "SMOKE TEST FAILED" : "ALL SMOKE TESTS PASSED");
