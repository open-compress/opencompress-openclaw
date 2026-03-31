/**
 * OpenCompress for OpenClaw
 *
 * Registers as an OpenClaw Provider. Users select opencompress/* models.
 * Local HTTP proxy compresses requests via opencompress.ai, then forwards
 * to the user's upstream provider. Keys never leave your machine.
 *
 * Auto-provisions API key on first load. No onboard step needed.
 */

import { VERSION, PROXY_PORT, PROXY_HOST, OCC_API, PROVIDER_ID } from "./config.js";
import { generateModelCatalog, type ProviderConfig } from "./models.js";
import { startProxy, stopProxy } from "./proxy.js";

// ---------------------------------------------------------------------------
// OpenClaw Plugin Types (duck-typed to avoid internal dependency)
// ---------------------------------------------------------------------------

type ModelApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
};

type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  api?: ModelApi;
  models: ModelDefinitionConfig[];
  [key: string]: unknown;
};

type ProviderPlugin = {
  id: string;
  label: string;
  aliases?: string[];
  envVars?: string[];
  models?: ModelProviderConfig;
  auth: Array<{
    id: string;
    label: string;
    hint?: string;
    kind: string;
    run: (ctx: any) => Promise<any>;
  }>;
};

type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  config: Record<string, any>;
  pluginConfig?: Record<string, any>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  registerProvider: (provider: ProviderPlugin) => void;
  registerService: (service: { id: string; start: () => void | Promise<void>; stop?: () => void | Promise<void> }) => void;
  registerCommand: (command: { name: string; description: string; acceptsArgs?: boolean; handler: (ctx: { args?: string }) => Promise<{ text: string }> }) => void;
  resolvePath: (input: string) => string;
  on: (hookName: string, handler: unknown) => void;
};

// ---------------------------------------------------------------------------
// API Key management — auto-provision on first load
// ---------------------------------------------------------------------------

let _cachedKey: string | undefined;

function getApiKey(api: OpenClawPluginApi): string | undefined {
  if (_cachedKey) return _cachedKey;

  // 1. Runtime config (from auth flow)
  const auth = api.config.auth as any;
  const fromConfig = auth?.profiles?.opencompress?.credentials?.["api-key"]?.apiKey;
  if (fromConfig) { _cachedKey = fromConfig; return fromConfig; }

  // 2. Environment variable
  if (process.env.OPENCOMPRESS_API_KEY) { _cachedKey = process.env.OPENCOMPRESS_API_KEY; return _cachedKey; }

  // 3. Plugin config
  if (api.pluginConfig?.apiKey) { _cachedKey = api.pluginConfig.apiKey as string; return _cachedKey; }

  // 4. Saved key file (written by auto-provision)
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const keyPath = path.join(os.homedir(), ".openclaw", "opencompress", "api-key");
    if (fs.existsSync(keyPath)) {
      const key = fs.readFileSync(keyPath, "utf-8").trim();
      if (key.startsWith("sk-occ-")) { _cachedKey = key; return key; }
    }
  } catch { /* ignore */ }

  return undefined;
}

/**
 * Auto-provision: call local proxy /provision to get a free API key.
 * The proxy forwards to opencompress.ai — plugin itself makes zero external requests.
 * Saves to ~/.openclaw/opencompress/api-key for persistence.
 */
async function autoProvision(api: OpenClawPluginApi): Promise<string | undefined> {
  try {
    const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/provision`, {
      method: "POST",
    });
    if (!res.ok) return undefined;

    const data = await res.json() as { apiKey: string; freeCredit: string };
    const key = data.apiKey;
    if (!key) return undefined;

    // Save to file
    try {
      const fs = require("fs");
      const os = require("os");
      const path = require("path");
      const dir = path.join(os.homedir(), ".openclaw", "opencompress");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "api-key"), key, { mode: 0o600 });
    } catch { /* ignore */ }

    _cachedKey = key;
    api.logger.info(`OpenCompress: auto-provisioned API key (${data.freeCredit} free credit)`);
    return key;
  } catch {
    return undefined;
  }
}

function getProviders(api: OpenClawPluginApi): Record<string, ProviderConfig> {
  return (api.config.models?.providers || {}) as Record<string, ProviderConfig>;
}

/**
 * Inject env.vars from OpenClaw config into process.env
 * so the proxy's builtin provider resolution can find API keys.
 * OpenClaw sets env.vars in config but may not inject them into process.env for plugins.
 */
function injectEnvVars(api: OpenClawPluginApi) {
  const envVars = api.config.env?.vars as Record<string, string> | undefined;
  if (!envVars) return;
  for (const [key, value] of Object.entries(envVars)) {
    if (!process.env[key] && value) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

function createProvider(api: OpenClawPluginApi): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "OpenCompress",
    aliases: ["oc", "compress"],
    envVars: ["OPENCOMPRESS_API_KEY"],

    models: (() => {
      const providers = getProviders(api);
      const firstProvider = Object.values(providers).find((p) => p.api);
      const primaryApi = (firstProvider?.api as ModelApi) || "openai-completions";
      return {
        baseUrl: `http://${PROXY_HOST}:${PROXY_PORT}/v1`,
        api: primaryApi,
        models: generateModelCatalog(providers) as ModelDefinitionConfig[],
      };
    })(),

    auth: [
      {
        id: "api-key",
        label: "OpenCompress",
        hint: "Save tokens and improve quality on any LLM. Your API keys stay local.",
        kind: "custom",
        run: async (ctx: any) => {
          ctx.prompter.note(
            "OpenCompress compresses LLM input and output to save tokens and improve quality.\n" +
            "Your existing API keys stay on your machine. We just make the traffic smaller.",
          );

          const spinner = ctx.prompter.progress("Creating your account...");
          try {
            const res = await fetch(`${OCC_API}/v1/provision`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source: "openclaw-plugin" }),
            });

            if (!res.ok) {
              spinner.stop("Failed");
              throw new Error(`Provisioning failed: ${res.statusText}`);
            }

            const data = await res.json() as { apiKey: string; freeCredit: string };
            spinner.stop("Account created!");
            _cachedKey = data.apiKey;

            return {
              profiles: [{
                profileId: "default",
                credential: { apiKey: data.apiKey },
              }],
              notes: [
                "OpenCompress ready!",
                `${data.freeCredit} free credit. No credit card needed.`,
                "",
                "Select any opencompress/* model to enable compression.",
              ],
            };
          } catch (err) {
            spinner.stop("Failed");
            throw err instanceof Error ? err : new Error(String(err));
          }
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Config injection — write provider + models to openclaw.json + auth-profiles
// (api.registerProvider() alone doesn't populate /models picker)
// ---------------------------------------------------------------------------

function injectConfig(api: OpenClawPluginApi) {
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    if (!fs.existsSync(configPath)) return;

    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    let changed = false;

    // 1. Discover user's existing models from agents.defaults.models
    //    (Built-in providers like Anthropic don't appear in models.providers)
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};
    if (!cfg.models) cfg.models = {};
    if (!cfg.models.providers) cfg.models.providers = {};

    const existingModels = Object.keys(cfg.agents.defaults.models)
      .filter((id: string) => !id.startsWith("opencompress/"));

    const occKey = getApiKey(api) || "auto-provision-pending";

    // Detect primary API type from existing models
    const hasAnthropic = existingModels.some((m: string) => m.startsWith("anthropic/"));
    const hasOpenAI = existingModels.some((m: string) => m.startsWith("openai/"));
    const primaryApi = hasAnthropic ? "anthropic-messages" : "openai-completions";

    // 2. Build compressed model list: auto + mirror of each existing model
    const compressedModels: any[] = [
      {
        id: "opencompress/auto",
        name: "OpenCompress Auto (compressed)",
        api: primaryApi,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ];

    for (const modelId of existingModels) {
      // Use - instead of / for sub-provider to avoid OpenClaw parsing issues
      // opencompress/anthropic-claude-sonnet-4-6 (not opencompress/anthropic/claude-sonnet-4-6)
      const compressedId = `opencompress/${modelId.replace("/", "-")}`;
      const provider = modelId.split("/")[0];
      const modelApi = provider === "anthropic" ? "anthropic-messages" : "openai-completions";
      const modelName = modelId.split("/").slice(1).join("/");

      compressedModels.push({
        id: compressedId,
        name: `${modelName} (compressed)`,
        api: modelApi,
        reasoning: modelId.includes("opus") || modelId.includes("o1") || modelId.includes("o3"),
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      });
    }

    // 3. Inject provider into models.providers.opencompress
    cfg.models.providers.opencompress = {
      baseUrl: `http://${PROXY_HOST}:${PROXY_PORT}/v1`,
      api: primaryApi,
      apiKey: occKey,
      models: compressedModels,
    };
    changed = true;

    // 4. Add all compressed models to agents.defaults.models allowlist
    for (const m of compressedModels) {
      if (!cfg.agents.defaults.models[m.id]) {
        cfg.agents.defaults.models[m.id] = {};
      }
    }

    // 3. Ensure plugins.allow includes opencompress
    if (!cfg.plugins) cfg.plugins = {};
    const allow = cfg.plugins.allow || [];
    if (!allow.includes("opencompress")) {
      cfg.plugins.allow = [...allow, "opencompress"];
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
      api.logger.info("OpenCompress: injected provider + models into config");
    }

    // 4. Inject auth profile for agent
    const agentsDir = path.join(os.homedir(), ".openclaw", "agents");
    if (fs.existsSync(agentsDir)) {
      for (const agent of fs.readdirSync(agentsDir)) {
        const authPath = path.join(agentsDir, agent, "agent", "auth-profiles.json");
        const authDir = path.dirname(authPath);
        if (!fs.existsSync(authDir)) continue;

        let profiles: any = { version: 1, profiles: {} };
        if (fs.existsSync(authPath)) {
          try { profiles = JSON.parse(fs.readFileSync(authPath, "utf-8")); } catch {}
        }

        if (!profiles.profiles["opencompress:default"]) {
          profiles.profiles["opencompress:default"] = {
            type: "api_key",
            provider: "opencompress",
            key: occKey,
          };
          fs.writeFileSync(authPath, JSON.stringify(profiles, null, 2) + "\n");
        }
      }
    }

    // 5. Also mutate runtime api.config so models work immediately
    if (api.config.models?.providers) {
      (api.config.models.providers as any).opencompress = cfg.models.providers.opencompress;
    }

  } catch (err) {
    api.logger.warn(`OpenCompress: config injection failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const plugin = {
  id: "opencompress",
  name: "OpenCompress",
  description: "Save tokens and sharpen quality on any LLM. Use your existing providers.",
  version: VERSION,

  register(api: OpenClawPluginApi) {
    // 0. Inject env vars from OpenClaw config (e.g. ANTHROPIC_API_KEY)
    injectEnvVars(api);

    // 1. Register as a Provider + inject into config files
    api.registerProvider(createProvider(api));
    injectConfig(api);
    api.logger.info(`OpenCompress v${VERSION} registered`);

    // 2. Start local proxy service
    api.registerService({
      id: "opencompress-proxy",
      start: () => {
        startProxy(
          () => getProviders(api),
          () => getApiKey(api),
        );
        api.logger.info(`OpenCompress proxy on ${PROXY_HOST}:${PROXY_PORT}`);
      },
      stop: () => {
        stopProxy();
      },
    });

    // 3. Startup: auto-provision key if missing, start proxy eagerly
    setTimeout(async () => {
      // Auto-provision key if not set
      if (!getApiKey(api)) {
        await autoProvision(api);
      }

      // Start proxy (may already be running from registerService)
      try {
        startProxy(
          () => getProviders(api),
          () => getApiKey(api),
        );
      } catch {
        // Port already in use — fine
      }
    }, 1500);

    // 4. /compress_stats command (underscore for Telegram compat)
    api.registerCommand({
      name: "compress_stats",
      description: "Show OpenCompress savings and balance",
      handler: async () => {
        let key = getApiKey(api);
        if (!key) {
          key = await autoProvision(api) || undefined;
        }
        if (!key) {
          return { text: "Could not provision API key. Check your network connection." };
        }

        try {
          const res = await fetch(`${OCC_API}/user/stats`, {
            headers: { Authorization: `Bearer ${key}` },
          });
          if (!res.ok) return { text: `Failed: HTTP ${res.status}` };

          const s = await res.json() as any;
          const balance = Number(s.balanceUsd || s.balance || 0);
          const calls = s.monthlyApiCalls ?? s.totalCalls ?? 0;
          const totalSaved = Number(s.month?.costSaved || s.totalSavings || 0);

          // Generate dashboard link token from key hash (first 16 chars of SHA-256)
          const crypto = require("crypto");
          const linkToken = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
          const dashboardUrl = `https://www.opencompress.ai/dashboard?link=${linkToken}`;

          const isLinked = !!(s.email || s.accountLinked);

          const lines = [
            "```",
            "OpenCompress",
            "============",
            `Balance:      $${balance.toFixed(4)}`,
            `Saved:        $${totalSaved.toFixed(4)}`,
            `API calls:    ${calls}`,
            "```",
            "",
          ];

          if (isLinked) {
            lines.push(`View details: ${dashboardUrl}`);
          } else {
            lines.push(`Sign up and claim $10 extra free credit: ${dashboardUrl}`);
          }

          return { text: lines.join("\n") };
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    // 5. /compress command (status + models)
    api.registerCommand({
      name: "compress",
      description: "Show OpenCompress status and available models",
      handler: async () => {
        let key = getApiKey(api);
        if (!key) {
          key = await autoProvision(api) || undefined;
        }

        const providers = getProviders(api);
        const models = generateModelCatalog(providers);

        return {
          text: [
            "**OpenCompress**",
            "",
            `API key: ${key ? `${key.slice(0, 15)}...` : "provisioning failed"}`,
            `Proxy: http://${PROXY_HOST}:${PROXY_PORT}`,
            "",
            "**Compressed models:**",
            ...models.map((m) => `  ${m.id}`),
            "",
            "Use `/model opencompress/auto` to enable compression.",
          ].join("\n"),
        };
      },
    });
  },
};

export default plugin;
