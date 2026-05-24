import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "ollama_local";
export const label = "Ollama (local)";

export const SANDBOX_INSTALL_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh";

export const DEFAULT_OLLAMA_LOCAL_MODEL = "llama3.2";

export function isValidOllamaModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes("/");
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_OLLAMA_LOCAL_MODEL, label: "Llama 3.2" },
  { id: "llama3.1", label: "Llama 3.1" },
  { id: "llama3", label: "Llama 3" },
  { id: "mistral", label: "Mistral" },
  { id: "mixtral", label: "Mixtral" },
  { id: "codellama", label: "Code Llama" },
  { id: "phi3", label: "Phi 3" },
  { id: "gemma2", label: "Gemma 2" },
  { id: "qwen2.5", label: "Qwen 2.5" },
  { id: "deepseek-coder-v2", label: "DeepSeek Coder V2" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use a smaller Ollama model as the budget lane.",
    adapterConfig: {
      model: "phi3",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to run Ollama locally as the agent runtime
- You want to use self-hosted open-source models
- You have Ollama installed and running on the machine

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Ollama CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, required): Ollama model name (e.g., llama3.2, mistral, codellama)
- baseUrl (string, optional): Ollama API base URL (default: http://localhost:11434)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "ollama"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Ollama must be running locally or accessible via the configured baseUrl.
- Runs are executed with: ollama run <model> ...
- The adapter uses Ollama's REST API for chat completions.
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
