import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "openrouter";
export const label = "OpenRouter";

export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4-20250514";

export function isValidOpenRouterModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.includes("/");
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OPENROUTER_MODEL, label: "Claude Sonnet 4" },
  { id: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet" },
  { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
  { id: "openai/gpt-4.1", label: "GPT-4.1" },
  { id: "openai/gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "openai/o3", label: "o3" },
  { id: "openai/o4-mini", label: "o4-mini" },
  { id: "google/gemini-pro-2.0", label: "Gemini Pro 2.0" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
  { id: "mistralai/mistral-large", label: "Mistral Large" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a lower-cost model on OpenRouter as the budget lane.",
    adapterConfig: {
      model: "meta-llama/llama-3.3-70b-instruct",
    },
    source: "adapter_default",
  },
  {
    key: "fast",
    label: "Fast",
    description: "Use a fast response model on OpenRouter.",
    adapterConfig: {
      model: "openai/gpt-4o",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# openrouter agent configuration

Adapter: openrouter

Use when:
- You want Paperclip to use OpenRouter's unified API for accessing multiple LLM providers
- You have an OpenRouter API key and want to access models from Anthropic, OpenAI, Google, Meta, etc.
- You want flexible model selection with unified billing through OpenRouter

Don't use when:
- You need direct provider API access (use claude_local, codex_local, etc.)
- You only need one-shot shell commands (use process)
- You don't have an OpenRouter API key

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): OpenRouter model ID in format "provider/model-name" (e.g., "anthropic/claude-sonnet-4-20250514")
- baseUrl (string, optional): OpenRouter API base URL (default: https://openrouter.ai/api/v1)
- promptTemplate (string, optional): run prompt template
- extraArgs (string[], optional): additional CLI args (not typically used for API-based adapters)
- env (object, optional): KEY=VALUE environment variables. Set OPENROUTER_API_KEY here or via environment.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Requires OPENROUTER_API_KEY environment variable or env.OPENROUTER_API_KEY configuration
- The adapter uses OpenRouter's OpenAI-compatible REST API for chat completions
- Default baseUrl is https://openrouter.ai/api/v1
- Model IDs must be in "provider/model-name" format as listed on OpenRouter
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling
`;
