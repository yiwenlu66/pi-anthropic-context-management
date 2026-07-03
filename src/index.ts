import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const DEFAULT_BETA_TOKENS = [
  "fine-grained-tool-streaming-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  CONTEXT_MANAGEMENT_BETA,
];

type JsonRecord = Record<string, unknown>;

interface LocalIdentity {
  device_id: string;
  session_id: string;
}

let cachedIdentity: LocalIdentity | undefined;

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

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function fallbackIdentity(): LocalIdentity {
  const seed = `${hostname()}\n${homedir()}\npi-anthropic-context-management`;
  const digest = createHash("sha256").update(seed).digest("hex");
  const uuidHex = createHash("sha256").update(`session\n${seed}`).digest("hex");
  return {
    device_id: digest,
    session_id: `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-4${uuidHex.slice(13, 16)}-8${uuidHex.slice(17, 20)}-${uuidHex.slice(20, 32)}`,
  };
}

function identityStatePath(): string {
  const explicit = env("PI_ANTHROPIC_CONTEXT_STATE");
  if (explicit) return explicit;
  const agentDir = env("PI_CODING_AGENT_DIR") ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "anthropic-context-management.json");
}

function readLocalIdentity(path: string): LocalIdentity | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (!isHex64(parsed.device_id) || !isUuid(parsed.session_id)) return undefined;
    return { device_id: parsed.device_id.toLowerCase(), session_id: parsed.session_id };
  } catch {
    return undefined;
  }
}

function writeLocalIdentity(path: string, identity: LocalIdentity): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function localIdentity(): LocalIdentity {
  if (cachedIdentity) return cachedIdentity;

  const path = identityStatePath();
  const existing = readLocalIdentity(path);
  if (existing) {
    cachedIdentity = existing;
    return existing;
  }

  const generated = {
    device_id: randomBytes(32).toString("hex"),
    session_id: randomUUID(),
  };

  try {
    writeLocalIdentity(path, generated);
    cachedIdentity = generated;
    return generated;
  } catch {
    const fallback = fallbackIdentity();
    cachedIdentity = fallback;
    return fallback;
  }
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
  const identity = localIdentity();
  return JSON.stringify({
    device_id: env("PI_ANTHROPIC_CONTEXT_DEVICE_ID") ?? identity.device_id,
    account_uuid: env("PI_ANTHROPIC_CONTEXT_ACCOUNT_UUID") ?? "",
    session_id: env("PI_ANTHROPIC_CONTEXT_SESSION_ID") ?? identity.session_id,
  });
}

function shouldSendContextManagement(payload: JsonRecord): boolean {
  const mode = env("PI_ANTHROPIC_CONTEXT_MANAGEMENT");
  if (mode === "always") return true;
  if (mode === "never") return false;

  // OCC currently rejects clear_thinking_20251015 when Pi serializes
  // thinking: { type: "disabled" }. In that state the stable metadata.user_id
  // is sufficient for cache affinity, so the context-management edit is only
  // added when thinking is actually enabled.
  const thinking = payload.thinking;
  return isRecord(thinking) && thinking.type !== "disabled";
}

function patchedPayload(payload: unknown): unknown | undefined {
  if (!isRecord(payload)) return undefined;
  if (!Array.isArray(payload.messages)) return undefined;

  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const nextPayload: JsonRecord = {
    ...payload,
    metadata: {
      ...metadata,
      user_id: stableUserId(),
    },
  };

  if (shouldSendContextManagement(payload)) {
    const existingContextManagement = isRecord(payload.context_management)
      ? payload.context_management
      : {};
    nextPayload.context_management = {
      ...existingContextManagement,
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    };
  }

  return nextPayload;
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
