import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "lmstudio_local";
export const label = "LM Studio (local)";

export const DEFAULT_LMSTUDIO_LOCAL_MODEL = "local-model";

export function isValidLmStudioModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0;
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_LMSTUDIO_LOCAL_MODEL, label: "Local Model" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a smaller local model as the budget lane.",
    adapterConfig: {
      model: DEFAULT_LMSTUDIO_LOCAL_MODEL,
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# lmstudio_local agent configuration

Adapter: lmstudio_local

Use when:
- You want Paperclip to run LM Studio locally as the agent runtime
- You want to use self-hosted LLM models via LM Studio's OpenAI-compatible API
- You have LM Studio installed and running on the machine with a model loaded

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- LM Studio server is not running or no model is loaded

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): LM Studio model ID (as shown in LM Studio's local server, e.g., "local-model" or the model's internal ID)
- baseUrl (string, optional): LM Studio API base URL (default: http://localhost:1234/v1)
- promptTemplate (string, optional): run prompt template
- extraArgs (string[], optional): additional CLI args (not typically used for API-based adapters)
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- LM Studio must be running with its local server enabled and a model loaded.
- The adapter uses LM Studio's OpenAI-compatible REST API for chat completions.
- Default baseUrl is http://localhost:1234/v1 (LM Studio's default local server port).
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
