# pi-phoenix-otel

[![Pi package](https://img.shields.io/badge/pi-package-6c5ce7)](https://pi.dev/packages)

Stream [pi](https://pi.dev) coding-agent sessions to [Arize Phoenix](https://github.com/Arize-ai/phoenix) as OpenTelemetry traces — and watch every prompt, tool call, token, and cent in a real trace waterfall.

**Zero dependencies.** The OTLP protobuf encoding is hand-rolled inside a single extension file (~250 lines). No collector, no SDK install, no Docker.

```bash
pi install npm:pi-phoenix-otel
```

## What you get

One trace per pi session:

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

Captured per turn: input/output tokens, cache read/write tokens, **cost**, request/response model, reasoning size.
Captured per tool call: name, arguments, result text, error flag, duration.
Captured per run/session: full prompt text (including steers & queued follow-ups), final response, image count, cwd, session id.

Prefer one trace per user prompt instead? Set `"trace": "run"` in the config.

## Requirements

- [Phoenix](https://github.com/Arize-ai/phoenix) running locally (no Docker needed):

  ```bash
  uvx arize-phoenix serve     # or: pip install arize-phoenix && phoenix serve
  ```

  UI opens on `http://localhost:6006`. Traces land in the configured project (auto-created).

- [pi](https://pi.dev) installed and working.

## Install

```bash
pi install npm:pi-phoenix-otel
```

Restart pi (or `/reload`) and send a message. That's it.

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
| `endpoint` | `http://localhost:6006/v1/traces` | OTLP/HTTP endpoint (works with any OTLP backend) |
| `service` | `pi-coding-agent` | `service.name` resource attribute |
| `project` | `pi` | Phoenix project (auto-created; also works with Grafana/Jaeger via generic OTLP) |
| `captureContent` | `true` | Set `false` for metadata-only tracing (no prompts/responses/tool text) |
| `trace` | `session` | `"session"` = one trace per session, `"run"` = one trace per user prompt |

Environment variables override the file: `PHOENIX_OTEL_ENDPOINT`, `PHOENIX_SERVICE_NAME`, `PHOENIX_PROJECT`, `PHOENIX_CAPTURE_CONTENT=0`, `PHOENIX_TRACE=run`, and `PHOENIX_OTEL_ENABLED=0` to disable.

A project-local config at `.pi/phoenix-otel.config.json` overrides the global one for that repo.

## Slash commands

- `/otel-flush` — flush pending spans immediately

## How it works

The extension subscribes to pi's lifecycle events (`input`, `agent_start/end`, `turn_start/end`, `message_end`, `tool_execution_start/end`, `session_shutdown`) and maps them onto spans following the [OpenInference](https://github.com/Arize-ai/openinference) / GenAI semantic conventions. Batches are encoded as OTLP/HTTP protobuf by hand and POSTed to your endpoint. If Phoenix is down, exports fail silently — your agent never notices.

Because it's plain OTLP, the same stream also works with Jaeger, Grafana Tempo, SigNoz, or any OTLP-capable backend.

## Privacy

Prompts, responses, and tool results are captured by default so traces are useful for debugging. Set `captureContent: false` (or `PHOENIX_CAPTURE_CONTENT=0`) to keep metadata only. Everything stays local unless you point `endpoint` elsewhere.

## Privacy & Security

- **Zero dependencies** — no supply-chain surface; one source file (~400 lines), fully auditable
- **No install-time code** — no npm lifecycle scripts; runs only when pi loads it
- **Local-first** — the only network call is a POST of spans to the endpoint *you* configure (`http://localhost:6006/v1/traces` by default); nothing is sent anywhere else
- **Content capture is on by default** so traces are useful for debugging — prompts, responses, and tool results are included and could contain sensitive material (e.g., secrets printed by a command you ran). Set `"captureContent": false` or `PHOENIX_CAPTURE_CONTENT=0` for metadata-only tracing (names, timings, token counts, costs)
- **No HTTPS enforcement** — if you point `endpoint` at a remote `http://` URL, traffic is unencrypted; use an HTTPS endpoint for anything non-local

## License

MIT
