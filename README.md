# pi-phoenix-otel

[![Pi package](https://img.shields.io/badge/pi-package-6c5ce7)](https://pi.dev/packages)

Stream [pi](https://pi.dev) coding-agent sessions to [Arize Phoenix](https://github.com/Arize-ai/phoenix) as OpenTelemetry traces — every prompt, tool call, token, and cent rendered as a queryable trace waterfall.

## Why This Exists

Agent sessions are black boxes: you see the final answer, but not the twelve tool calls, two dead ends, and 40k cache-tokens it took to get there. LLM observability tools solve this — but wiring a coding agent into one usually means an SDK dependency, a collector daemon, or both.

This extension is none of that. It subscribes to pi's lifecycle events, hand-encodes OTLP protobuf in ~400 lines of zero-dependency TypeScript, and POSTs straight to Phoenix. If Phoenix is down, exports fail silently and your agent never notices.

**Zero dependencies. No install-time scripts. One auditable file.**

## Requirements

- [pi](https://pi.dev) installed and working
- [Phoenix](https://github.com/Arize-ai/phoenix), running locally (no Docker needed):

  ```bash
  uvx arize-phoenix serve     # or: pip install arize-phoenix && phoenix serve
  ```

  UI opens on `http://localhost:6006`. Projects are auto-created on first trace.

## Install

```bash
pi install npm:pi-phoenix-otel
```

Then restart pi (or run `/reload`) and send a message.

### First run

| You have... | What happens |
| --- | --- |
| Phoenix already running | Traces flow immediately into your configured project |
| Phoenix not running | Run `/otel-start` — launches Phoenix via `uvx` in the background, waits for health, notifies you |

## What You Get

One trace per pi session (default):

```
pi.session · my-repo
├── pi.run 1 · fix the login bug
│   ├── pi.turn 0        (tokens, cost, model)
│   │   ├── execute_tool read
│   │   └── execute_tool edit
│   └── pi.turn 1
├── pi.run 2 · now write tests
│   └── pi.turn 0 ── execute_tool bash
└── ...
```

| Level | Captured |
| --- | --- |
| Turn | input/output tokens, cache read/write tokens, **cost**, request/response model, reasoning size |
| Tool call | name, arguments, result text, error flag, duration |
| Run | prompt text (incl. steers & queued follow-ups), final response, image count |
| Session | session id/path, cwd, run count, total duration |

Prefer one trace per user prompt instead of per session? Set `"trace": "run"` in the config.

## Configuration

Optional config file at `~/.pi/agent/phoenix-otel.config.json`:

```json
{
	"endpoint": "http://localhost:6006/v1/traces",
	"service": "pi-coding-agent",
	"project": "my-project",
	"captureContent": true,
	"trace": "session"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `endpoint` | `http://localhost:6006/v1/traces` | OTLP/HTTP endpoint — any OTLP backend works (Grafana Tempo, Jaeger, SigNoz…) |
| `service` | `pi-coding-agent` | `service.name` resource attribute |
| `project` | `pi` | Phoenix project name — auto-created on first trace |
| `captureContent` | `true` | `false` = metadata-only tracing (no prompts/responses/tool text) |
| `trace` | `session` | `"session"` = one trace per session · `"run"` = one trace per user prompt |

A project-local config at `.pi/phoenix-otel.config.json` overrides the global file for that repo. Environment variables override everything: `PHOENIX_OTEL_ENDPOINT`, `PHOENIX_SERVICE_NAME`, `PHOENIX_PROJECT`, `PHOENIX_TRACE`, `PHOENIX_CAPTURE_CONTENT=0`.

## Slash Commands

| Command | Action |
| --- | --- |
| `/otel-start` | Launch Phoenix via `uvx arize-phoenix serve` as a detached background process; polls until healthy (survives pi exiting; logs to `/tmp/pi-phoenix.log`) |
| `/otel-status` | Server status, endpoint, project, service, capture mode, trace mode |
| `/otel-flush` | Flush pending spans immediately |

## Privacy & Security

- **Zero dependencies** — no supply-chain surface; one source file (~400 lines), fully auditable
- **No install-time code** — no npm lifecycle scripts; runs only when pi loads it
- **Local-first** — the only network call is a POST of spans to the endpoint *you* configure (`http://localhost:6006/v1/traces` by default); nothing is sent anywhere else
- **Content capture is on by default** so traces are useful for debugging — prompts, responses, and tool results are included and can contain sensitive material (e.g., secrets echoed by a command you ran). Set `"captureContent": false` or `PHOENIX_CAPTURE_CONTENT=0` for metadata-only tracing
- **No HTTPS enforcement** — if you point `endpoint` at a remote `http://` URL, traffic is unencrypted; use HTTPS for anything non-local

## License

MIT
