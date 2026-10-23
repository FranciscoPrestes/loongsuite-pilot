# Model, effort and router metadata (NTConsult fork)

The collector records model choice and reasoning effort only when the source explicitly exposes them. Missing values stay missing: no default effort, no model name inferred from another call, and no `unknown` placeholder written as if it were a model.

## Fields

| Field | Meaning |
|---|---|
| `gen_ai.request.model` | Model requested by the agent for this call |
| `gen_ai.response.model` | Model named by the response. It is the provider's claim, not proof of the physical backend |
| `gen_ai.request.reasoning.level` | Explicit categorical effort (`low`, `medium`, `high`, ...) |
| `gen_ai.request.reasoning.budget_tokens` | Explicit thinking budget. `0` is preserved as an explicit value |
| `gen_ai.request.thinking.type` | Explicit thinking mode (`enabled`, `adaptive`, ...) |
| `gen_ai.request.model_settings.source` | Where the settings came from (`codex.turn_context`, `claude.preload`, `claude.transcript`) |
| `gen_ai.request.model_settings.scope` | `request` (per LLM call) or `turn` (applies to the whole native turn) |
| `gen_ai.request.router.*` | Claude Code Router decision: `name`, `selected_model`, `provider`, `reason`, `reasoning.level`, `reasoning.budget_tokens` |

`gen_ai.request.reasoning.level` follows the OpenTelemetry GenAI convention. The budget, source, scope and router fields are NTConsult extensions.

Values are strings up to 256 characters (64 for effort/mode) without control characters, or safe non-negative integers for budgets. Anything else is dropped at the normalization boundary. When two explicit spellings of effort disagree, none is recorded.

## Per call, not per turn

The OTLP converter's passthrough is turn-scoped and would copy the first call's settings into later calls. Settings are therefore attached after conversion, by exact identity: the native span ID, or session + turn + response ID (LLM) / tool call ID (TOOL). Ambiguous or unmatched metadata is omitted. Tool spans may carry the context of the call that declared them; usage and cost are never duplicated.

## Sources

- **Codex**: `turn_context.payload.model` and `.effort`, snapshotted at the start of each model wave and kept in the transcript checkpoint across restarts.
- **Claude Code**: the existing fetch preload reads only allowlisted scalars from the request body (`model`, `output_config.effort`, `reasoning.effort`, `reasoning_effort`, `thinking.type`, `thinking.budget_tokens`) and `message_start.message.model`. It also records the final W3C `traceparent` actually sent. Headers, bodies and credentials are never persisted.
- **Claude Code Router (CCR 3.x)**: `assets/plugins/ccr/router-observer.mjs` is an official gateway plugin. It captures the original request before routing, the final upstream request and the response model, writes one private record per request under `~/.loongsuite-pilot/router/ccr/`, and returns streams byte-for-byte. The hook processor joins a record only when both the final `traceparent` and the response ID match exactly one call; the file is removed only after the JSONL is written.

## Enabling the CCR observer

Register it through CCR's own configuration (the UI or its local `saveConfig` RPC), never by editing the generated gateway config:

```json
{ "id": "ntconsult-router-observer", "enabled": true, "surfaces": ["gateway"],
  "permissions": ["core-gateway-plugins"],
  "coreGateway": { "plugins": [{ "key": "ntconsult-router-observer", "enabled": true,
    "modulePath": "/ABSOLUTE/HOME/.loongsuite-pilot/plugins/ccr/router-observer.mjs" }] } }
```

`modulePath` must be absolute. Changing plugins restarts CCR's shared gateway.

## Limits

- `fetch(Request)` bodies sent as `ReadableStream` are not consumed, so their settings are not captured.
- Router metadata joins only when the gateway sees the preload's final `traceparent`; a caller-set header that differs still works, an absent one does not.
- Response model is what the provider reports. Aliases and upstream proxies may name a different identifier than the hardware that ran the call.
