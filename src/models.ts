/**
 * Dynamic model resolution — parse opencompress/* model IDs
 * and resolve upstream provider + key from user's existing config.
 */

export interface UpstreamInfo {
  upstreamProvider: string;
  upstreamModel: string;
  upstreamKey: string | undefined;
  upstreamBaseUrl: string;
  upstreamApi: string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  api?: string;
  models?: Array<{ id: string; name: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Resolve opencompress/provider/model → upstream provider info.
 *
 * Formats:
 *   opencompress/auto                      → first available provider, first model
 *   opencompress/anthropic/claude-sonnet-4  → specific provider + model
 *   opencompress/openai/gpt-5.4            → specific provider + model
 */
/**
 * Well-known provider defaults. OpenClaw's built-in providers (anthropic, openai)
 * often don't appear in models.providers — they use env vars + agents.defaults.model.
 */
const BUILTIN_PROVIDERS: Record<string, { baseUrl: string; api: string; envVar: string; defaultModel: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", envVar: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-20250514" },
  openai: { baseUrl: "https://api.openai.com", api: "openai-completions", envVar: "OPENAI_API_KEY", defaultModel: "gpt-4o" },
  google: { baseUrl: "https://generativelanguage.googleapis.com", api: "google-generative-ai", envVar: "GOOGLE_API_KEY", defaultModel: "gemini-2.0-flash" },
  xai: { baseUrl: "https://api.x.ai", api: "openai-completions", envVar: "XAI_API_KEY", defaultModel: "grok-3" },
  deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", envVar: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
};

/** Try to resolve a built-in provider from env vars when models.providers is empty. */
function resolveBuiltin(providerId: string): UpstreamInfo | null {
  const builtin = BUILTIN_PROVIDERS[providerId];
  if (!builtin) return null;
  const key = process.env[builtin.envVar];
  if (!key) return null;
  return {
    upstreamProvider: providerId,
    upstreamModel: builtin.defaultModel,
    upstreamKey: key,
    upstreamBaseUrl: builtin.baseUrl,
    upstreamApi: builtin.api,
  };
}

export function resolveUpstream(
  modelId: string,
  providers: Record<string, ProviderConfig>,
): UpstreamInfo | null {
  const stripped = modelId.replace(/^opencompress\//, "");

  if (stripped === "auto") {
    // 1. Try explicit providers first
    for (const [id, config] of Object.entries(providers)) {
      if (id === "opencompress") continue;
      const firstModel = config.models?.[0]?.id;
      if (!firstModel) continue;
      return {
        upstreamProvider: id,
        upstreamModel: firstModel,
        upstreamKey: config.apiKey,
        upstreamBaseUrl: config.baseUrl,
        upstreamApi: config.api || "openai-completions",
      };
    }
    // 2. Fallback: detect from env vars (built-in providers)
    for (const [id, builtin] of Object.entries(BUILTIN_PROVIDERS)) {
      const key = process.env[builtin.envVar];
      if (key) {
        return {
          upstreamProvider: id,
          upstreamModel: builtin.defaultModel,
          upstreamKey: key,
          upstreamBaseUrl: builtin.baseUrl,
          upstreamApi: builtin.api,
        };
      }
    }
    return null;
  }

  // Parse provider/model or provider-model
  // Formats:
  //   anthropic/claude-sonnet-4-6  (slash-separated)
  //   anthropic-claude-sonnet-4-6  (dash-separated, from model ID)
  const slashIdx = stripped.indexOf("/");

  let upstreamProvider: string;
  let upstreamModel: string;

  if (slashIdx !== -1) {
    // Slash format: provider/model
    upstreamProvider = stripped.slice(0, slashIdx);
    upstreamModel = stripped.slice(slashIdx + 1);
  } else {
    // Try dash format: match known provider prefixes
    const knownProviders = ["anthropic", "openai", "google", "xai", "deepseek"];
    const matched = knownProviders.find((p) => stripped.startsWith(p + "-"));
    if (matched) {
      upstreamProvider = matched;
      upstreamModel = stripped.slice(matched.length + 1); // skip "provider-"
    } else {
      // Unknown format — try as provider name
      const config = providers[stripped];
      if (config) {
        return {
          upstreamProvider: stripped,
          upstreamModel: config.models?.[0]?.id || stripped,
          upstreamKey: config.apiKey,
          upstreamBaseUrl: config.baseUrl,
          upstreamApi: config.api || "openai-completions",
        };
      }
      const builtin = resolveBuiltin(stripped);
      if (builtin) return builtin;
      return null;
    }
  }
  const config = providers[upstreamProvider];

  if (config) {
    return {
      upstreamProvider,
      upstreamModel,
      upstreamKey: config.apiKey,
      upstreamBaseUrl: config.baseUrl,
      upstreamApi: config.api || "openai-completions",
    };
  }

  // Fallback to builtin provider
  const builtin = resolveBuiltin(upstreamProvider);
  if (builtin) {
    return { ...builtin, upstreamModel };
  }

  return null;
}

/**
 * Generate model catalog from user's existing providers.
 * For each existing model, create an opencompress/* variant.
 */
export function generateModelCatalog(
  providers: Record<string, ProviderConfig>,
): Array<{ id: string; name: string; api: string; [k: string]: unknown }> {
  const models: Array<{ id: string; name: string; api: string; [k: string]: unknown }> = [];

  for (const [providerId, config] of Object.entries(providers)) {
    if (providerId === "opencompress") continue;

    for (const model of config.models || []) {
      models.push({
        ...model,
        id: `opencompress/${providerId}/${model.id}`,
        name: `${model.name || model.id} (compressed)`,
        api: config.api || "openai-completions",
      });
    }
  }

  // Always add auto model
  models.unshift({
    id: "opencompress/auto",
    name: "OpenCompress Auto (compressed, uses default provider)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  });

  return models;
}
