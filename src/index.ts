import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const DEFAULT_BETA_TOKENS = [
  "fine-grained-tool-streaming-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  CONTEXT_MANAGEMENT_BETA,
];

const DEFAULT_DEVICE_ID = "pi-anthropic-context-management";
const DEFAULT_SESSION_ID = "pi-anthropic-context-management";

type JsonRecord = Record<string, unknown>;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envList(name: string): Set<string> | undefined {
  const value = env(name);
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? new Set(items) : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldPatchProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  const include = envList("PI_ANTHROPIC_CONTEXT_PROVIDERS");
  const exclude = envList("PI_ANTHROPIC_CONTEXT_EXCLUDE_PROVIDERS");
  if (include && !include.has(provider)) return false;
  if (exclude?.has(provider)) return false;
  return true;
}

function isAnthropicMessagesContext(ctx: ExtensionContext): boolean {
  return ctx.model?.api === "anthropic-messages" && shouldPatchProvider(ctx.model.provider);
}

function stableUserId(): string {
  return JSON.stringify({
    device_id: env("PI_ANTHROPIC_CONTEXT_DEVICE_ID") ?? DEFAULT_DEVICE_ID,
    account_uuid: env("PI_ANTHROPIC_CONTEXT_ACCOUNT_UUID") ?? "",
    session_id: env("PI_ANTHROPIC_CONTEXT_SESSION_ID") ?? DEFAULT_SESSION_ID,
  });
}

function patchedPayload(payload: unknown): unknown | undefined {
  if (!isRecord(payload)) return undefined;
  if (!Array.isArray(payload.messages)) return undefined;

  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const existingContextManagement = isRecord(payload.context_management)
    ? payload.context_management
    : {};

  return {
    ...payload,
    metadata: {
      ...metadata,
      user_id: stableUserId(),
    },
    context_management: {
      ...existingContextManagement,
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
  };
}

function betaHeaderValue(): string {
  return env("PI_ANTHROPIC_CONTEXT_BETA") ?? DEFAULT_BETA_TOKENS.join(",");
}

async function patchProviderHeaders(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!envBool("PI_ANTHROPIC_CONTEXT_PATCH_HEADERS", true)) return;

  const providers = new Set(
    ctx.modelRegistry
      .getAll()
      .filter((model) => model.api === "anthropic-messages" && shouldPatchProvider(model.provider))
      .map((model) => model.provider),
  );

  for (const provider of providers) {
    // Pi's registerProvider({ headers }) replaces the provider request config, including
    // apiKey. Resolve and re-register the current API key so the header patch does not
    // silently de-authenticate API-key providers. This is in-memory only.
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
    if (!apiKey) continue;

    pi.registerProvider(provider, {
      apiKey,
      headers: {
        "anthropic-beta": betaHeaderValue(),
      },
    });
  }
}

export default function anthropicContextManagement(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await patchProviderHeaders(pi, ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await patchProviderHeaders(pi, ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isAnthropicMessagesContext(ctx)) return undefined;
    return patchedPayload(event.payload);
  });
}
