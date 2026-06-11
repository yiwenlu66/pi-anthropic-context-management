# pi-anthropic-context-management

Pi extension for Anthropic Messages-compatible providers. It adds two Claude/Anthropic request fields that improve cache affinity on New API / Claude-Code-compatible routers:

- `metadata.user_id` as a stable Claude-Code-shaped JSON string
- `context_management.edits=[{type:"clear_thinking_20251015", keep:"all"}]`

It also patches Anthropic Messages providers with the `anthropic-beta` header needed for `context_management`.

## Why

Some Anthropic-compatible routers use `metadata.user_id` as a channel/cache affinity key. Without a stable Claude-Code-shaped value, a repeated Pi conversation can keep rewriting the visible prompt suffix instead of reading it from prompt cache.

## What `clear_thinking_20251015` does

Primary SDK source: `anthropic-sdk-typescript/src/resources/beta/messages/messages.ts` defines:

```ts
interface BetaClearThinking20251015Edit {
  type: "clear_thinking_20251015";
  /** Number of most recent assistant turns to keep thinking blocks for. Older turns will have their thinking blocks removed. */
  keep?: BetaThinkingTurns | BetaAllThinkingTurns | "all";
}
```

The same SDK defines the response shape with `cleared_input_tokens` and `cleared_thinking_turns`.

This extension uses `keep:"all"`, which asks Anthropic to keep all thinking turns, so no thinking turns should be eligible for clearing. The practical effect is to send the same context-management shape used by recent Claude Code clients while avoiding intentional context deletion.

Known side effects/risks:

- The request must include the beta token `context-management-2025-06-27`; otherwise Anthropic-compatible upstreams may reject `context_management` as an extra input.
- `context_management` is a beta API surface. Unsupported providers/models may reject it even with the header.
- Header patching in Pi is provider-level. This extension resolves the current API key and re-registers the provider with an `anthropic-beta` header in memory. If you use OAuth, `authHeader`, or additional custom provider-level headers, disable header patching and configure headers yourself.
- If you change `keep` away from `"all"`, this feature can remove older thinking blocks from request context.

## Installation

From GitHub once published:

```sh
pi install github:yiwenlu66/pi-anthropic-context-management
```

For local testing:

```sh
pi -e /path/to/pi-anthropic-context-management/src/index.ts --model <provider>/<model>
```

## Configuration

Defaults apply to all Pi models whose resolved `model.api` is `anthropic-messages`.

On first use, the extension creates a local identity file containing a 64-hex `device_id` and UUID `session_id`:

```text
$PI_CODING_AGENT_DIR/anthropic-context-management.json
# or ~/.pi/agent/anthropic-context-management.json
```

The file is local machine state, not intended for git.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_ANTHROPIC_CONTEXT_PATCH_HEADERS` | `true` | Set provider-level `anthropic-beta` header for Anthropic Messages API-key providers. Disable for OAuth/authHeader/custom-header providers. |
| `PI_ANTHROPIC_CONTEXT_PROVIDERS` | unset | Comma-separated provider allowlist, e.g. `anthropic,my-anthropic-proxy`. |
| `PI_ANTHROPIC_CONTEXT_EXCLUDE_PROVIDERS` | unset | Comma-separated provider denylist. |
| `PI_ANTHROPIC_CONTEXT_STATE` | `$PI_CODING_AGENT_DIR/anthropic-context-management.json` | Local identity state path. |
| `PI_ANTHROPIC_CONTEXT_DEVICE_ID` | generated 64-hex value | Override `device_id` inside `metadata.user_id`. |
| `PI_ANTHROPIC_CONTEXT_ACCOUNT_UUID` | empty | `account_uuid` inside `metadata.user_id`. |
| `PI_ANTHROPIC_CONTEXT_SESSION_ID` | generated UUID | Override `session_id` inside `metadata.user_id`. |
| `PI_ANTHROPIC_CONTEXT_BETA` | `fine-grained-tool-streaming-2025-05-14,prompt-caching-scope-2026-01-05,context-management-2025-06-27` | Exact `anthropic-beta` value to set when header patching is enabled. |

For New API cache affinity, keep `PI_ANTHROPIC_CONTEXT_SESSION_ID` stable across turns that should share cache routing. If you override `device_id` or `session_id`, use Claude-Code-shaped values: a 64-hex `device_id` and UUID `session_id`.

## Scope

This extension does not mimic Claude Code OAuth, billing headers, tool schemas, or response tool-name transforms. It only adds context-management and stable metadata fields.
