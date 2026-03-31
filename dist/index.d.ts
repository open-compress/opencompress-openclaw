/**
 * OpenCompress for OpenClaw
 *
 * Registers as an OpenClaw Provider. Users select opencompress/* models.
 * Local HTTP proxy compresses requests via opencompress.ai, then forwards
 * to the user's upstream provider. Keys never leave your machine.
 *
 * Auto-provisions API key on first load. No onboard step needed.
 */
type ModelApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
type ModelDefinitionConfig = {
    id: string;
    name: string;
    api?: ModelApi;
    reasoning?: boolean;
    input?: string[];
    cost?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
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
    logger: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    registerProvider: (provider: ProviderPlugin) => void;
    registerService: (service: {
        id: string;
        start: () => void | Promise<void>;
        stop?: () => void | Promise<void>;
    }) => void;
    registerCommand: (command: {
        name: string;
        description: string;
        acceptsArgs?: boolean;
        handler: (ctx: {
            args?: string;
        }) => Promise<{
            text: string;
        }>;
    }) => void;
    resolvePath: (input: string) => string;
    on: (hookName: string, handler: unknown) => void;
};
declare const plugin: {
    id: string;
    name: string;
    description: string;
    version: string;
    register(api: OpenClawPluginApi): void;
};

export { plugin as default };
