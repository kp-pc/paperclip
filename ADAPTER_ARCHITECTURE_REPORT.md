# Paperclip Adapter Architecture Report

## Executive Summary

Paperclip has a mature adapter-based architecture for integrating various LLM providers and coding agents. The adapters for **Ollama**, **LM Studio**, and **OpenRouter** already exist in the codebase at:
- `/workspace/packages/adapters/ollama-local/`
- `/workspace/packages/adapters/lmstudio-local/`
- `/workspace/packages/adapters/openrouter/`

However, these adapters are **NOT registered** in the server's adapter registry, meaning they are not currently usable by end users through the UI or API.

---

## 1. Current Adapter Architecture

### Package Structure

Each adapter follows a consistent monorepo package structure:

```
packages/adapters/{adapter-name}/
├── package.json           # Package metadata with exports map
├── src/
│   ├── index.ts          # Public exports (type, label, models, modelProfiles, agentConfigurationDoc)
│   ├── server/
│   │   ├── index.ts      # Server module exports (execute, testEnvironment, sessionCodec)
│   │   ├── execute.ts    # Main execution logic
│   │   └── test.ts       # Environment testing (optional)
│   ├── ui/
│   │   └── index.ts      # UI components/hooks (optional)
│   └── cli/
│       └── index.ts      # CLI formatting (optional)
```

### Adapter Module Interface (`ServerAdapterModule`)

From `/workspace/packages/adapter-utils/src/types.ts`:

```typescript
interface ServerAdapterModule {
  type: string;                              // e.g., "ollama_local", "lmstudio_local", "openrouter"
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  listSkills?: (ctx: AdapterSkillContext) => Promise<AdapterSkillSnapshot>;
  syncSkills?: (ctx: AdapterSkillContext, desiredSkills: string[]) => Promise<AdapterSkillSnapshot>;
  sessionCodec?: AdapterSessionCodec;
  sessionManagement?: AdapterSessionManagement;
  supportsLocalAgentJwt?: boolean;
  models?: AdapterModel[];
  listModels?: () => Promise<AdapterModel[]>;
  modelProfiles?: AdapterModelProfileDefinition[];
  listModelProfiles?: () => Promise<AdapterModelProfileDefinition[]>;
  refreshModels?: () => Promise<AdapterModel[]>;
  agentConfigurationDoc?: string;
  onHireApproved?: (payload: HireApprovedPayload, adapterConfig: Record<string, unknown>) => Promise<HireApprovedHookResult>;
  getQuotaWindows?: () => Promise<ProviderQuotaResult>;
  detectModel?: () => Promise<{ model: string; provider: string; source: string } | null>;
  getConfigSchema?: () => Promise<AdapterConfigSchema> | AdapterConfigSchema;
  
  // Capability flags
  supportsInstructionsBundle?: boolean;
  instructionsPathKey?: string;
  requiresMaterializedRuntimeSkills?: boolean;
  getRuntimeCommandSpec?: (config: Record<string, unknown>) => AdapterRuntimeCommandSpec | null;
}
```

---

## 2. Existing Provider Interfaces

### Registered Adapters (in `/workspace/server/src/adapters/registry.ts`)

Currently registered adapters:
- `acpx_local` - ACPX local runner
- `claude_local` - Claude Code CLI
- `codex_local` - Codex CLI
- `cursor_cloud` - Cursor Cloud
- `cursor_local` - Cursor Local
- `gemini_local` - Gemini CLI
- `grok_local` - Grok CLI
- `hermes_local` - Hermes adapter
- `openclaw_gateway` - OpenClaw Gateway
- `opencode_local` - OpenCode local
- `pi_local` - Pi Coding Agent
- `process` - Generic process adapter
- `http` - HTTP webhook adapter

### Unregistered Adapters (exist but NOT in registry)

- `ollama_local` - Ollama local API ✅ EXISTS
- `lmstudio_local` - LM Studio local API ✅ EXISTS
- `openrouter` - OpenRouter API ✅ EXISTS

---

## 3. Agent Runtime Flow

### Execution Context

```typescript
interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;           // { id, companyId, name, adapterType, adapterConfig }
  runtime: AdapterRuntime;       // { sessionId, sessionParams, taskKey }
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  executionTarget?: AdapterExecutionTarget;
  executionTransport?: { remoteExecution?: Record<string, unknown> };
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  authToken?: string;
}
```

### Execution Result

```typescript
interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  usage?: UsageSummary;          // { inputTokens, outputTokens, cachedInputTokens }
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  summary?: string | null;
  question?: { prompt: string; choices: Array<{ key: string; label: string }> } | null;
}
```

---

## 4. Configuration Schema

### Adapter Config Fields

Adapters define configuration via:
1. Static exports in `index.ts` (models, modelProfiles)
2. Dynamic schema via `getConfigSchema()` method
3. Documentation via `agentConfigurationDoc`

### Example Config Schema Interface

```typescript
interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea" | "combobox";
  options?: ConfigFieldOption[];
  default?: unknown;
  hint?: string;
  required?: boolean;
  group?: string;
  meta?: Record<string, unknown>;
}
```

### Environment Variables

- `OLLAMA_BASE_URL` - Ollama API endpoint (default: `http://localhost:11434`)
- `LMSTUDIO_BASE_URL` - LM Studio API endpoint (default: `http://localhost:1234/v1`)
- `OPENROUTER_API_KEY` - OpenRouter API key (required)
- `OPENROUTER_BASE_URL` - OpenRouter endpoint (default: `https://openrouter.ai/api/v1`)

---

## 5. Environment Variable Loading

Environment variables are loaded through:
1. `config.env` object in adapter configuration
2. `process.env` fallbacks
3. `authToken` injection from Paperclip runtime

Example from OpenRouter adapter:
```typescript
const openRouterApiKey =
  typeof envConfig.OPENROUTER_API_KEY === "string" && envConfig.OPENROUTER_API_KEY.trim().length > 0
    ? envConfig.OPENROUTER_API_KEY.trim()
    : process.env.OPENROUTER_API_KEY?.trim() || null;
```

---

## 6. Settings/Config UI

UI integration points:
- `/workspace/ui/src/api/adapters.ts` - API client for adapter operations
- `/workspace/ui/src/pages/AdapterManager.tsx` - Adapter management UI
- `/workspace/ui/src/pages/NewAgent.tsx` - Agent creation with adapter selection
- `/workspace/ui/src/pages/AgentDetail.tsx` - Agent configuration editing

Model/provider labels mapping in `/workspace/ui/src/lib/utils.ts`:
```typescript
openrouter: "OpenRouter"
```

---

## 7. API Abstraction Layers

### Shared Utilities (`@paperclipai/adapter-utils`)

Located at `/workspace/packages/adapter-utils/src/`:

| Module | Purpose |
|--------|---------|
| `types.ts` | Core interfaces (ServerAdapterModule, AdapterExecutionContext, etc.) |
| `server-utils.ts` | Helper functions (asString, asNumber, renderTemplate, buildPaperclipEnv) |
| `execution-target.ts` | Remote/local execution target abstraction |
| `ssh.ts` | SSH/shell quoting utilities |
| `billing.ts` | Provider/biller detection logic |
| `session-compaction.ts` | Session management |
| `sandbox-managed-runtime.ts` | Sandbox runtime management |

### Common Patterns

All adapters use:
- `buildPaperclipEnv(agent)` - Build standard Paperclip environment variables
- `renderTemplate(promptTemplate, variables)` - Template rendering
- `joinPromptSections(parts)` - Combine instructions, wake prompts, user prompts
- `readAdapterExecutionTarget()` - Read execution target from context

---

## 8. Streaming Implementation

### Ollama Streaming
Uses Ollama's native streaming API (`/api/chat` with `stream: true`):
```typescript
const ollamaRequest = {
  model,
  messages: [{ role: "user", content: renderedPrompt }],
  stream: true,
};
// Parse NDJSON response lines
```

### LM Studio Streaming
Uses OpenAI-compatible SSE format:
```typescript
const requestBody = {
  model,
  messages: [{ role: "user", content: renderedPrompt }],
  stream: true,
};
// Parse `data: ` prefixed SSE chunks
```

### OpenRouter Streaming
Uses OpenAI-compatible SSE format (same as LM Studio):
```typescript
const openRouterRequest = {
  model,
  messages: [{ role: "user", content: renderedPrompt }],
  stream: true,
};
// Parse `data: ` prefixed SSE chunks
```

---

## 9. Tool-Calling Implementation

Current adapters primarily use **prompt-based tool calling** rather than native function calling:
- Instructions include tool usage guidelines
- Tools are invoked via shell commands or HTTP requests
- Results parsed from stdout/stderr

The `TranscriptEntry` type supports tool call tracking:
```typescript
type TranscriptEntry =
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  // ... other entry types
```

---

## 10. Existing OpenAI-Compatible Transport Logic

### LM Studio & OpenRouter

Both use OpenAI-compatible APIs:
- Endpoint: `POST /chat/completions`
- Request format: `{ model, messages, stream }`
- Response format: SSE with `data: { choices: [{ delta: { content } }] }`

### Billing Detection

From `/workspace/packages/adapter-utils/src/billing.ts`:
```typescript
if (explicitOpenRouterKey) return "openrouter";
if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter";
```

---

## Important Files

### Core Infrastructure
| File | Purpose |
|------|---------|
| `/workspace/packages/adapter-utils/src/types.ts` | Core adapter interfaces |
| `/workspace/server/src/adapters/registry.ts` | Adapter registration and lookup |
| `/workspace/server/src/adapters/plugin-loader.ts` | External plugin loading |
| `/workspace/server/src/adapters/builtin-adapter-types.ts` | Built-in adapter type list |

### Existing Adapters (Unregistered)
| File | Purpose |
|------|---------|
| `/workspace/packages/adapters/ollama-local/src/index.ts` | Ollama adapter definition |
| `/workspace/packages/adapters/ollama-local/src/server/execute.ts` | Ollama execution logic |
| `/workspace/packages/adapters/lmstudio-local/src/index.ts` | LM Studio adapter definition |
| `/workspace/packages/adapters/lmstudio-local/src/server/execute.ts` | LM Studio execution logic |
| `/workspace/packages/adapters/openrouter/src/index.ts` | OpenRouter adapter definition |
| `/workspace/packages/adapters/openrouter/src/server/execute.ts` | OpenRouter execution logic |

### UI Integration
| File | Purpose |
|------|---------|
| `/workspace/ui/src/api/adapters.ts` | Adapter API client |
| `/workspace/ui/src/pages/AdapterManager.tsx` | Adapter management UI |
| `/workspace/ui/src/lib/utils.ts` | Provider label mappings |

---

## Data Flow

```
User creates/edits agent in UI
        ↓
UI calls GET/POST /api/adapters
        ↓
Server loads adapter via getServerAdapter(adapterType)
        ↓
AdapterRegistry looks up adapter by type
        ↓
Adapter.execute(AdapterExecutionContext) called
        ↓
Adapter makes HTTP request to provider (Ollama/LM Studio/OpenRouter)
        ↓
Streaming response parsed and forwarded via onLog()
        ↓
Execution result returned with usage metrics
        ↓
Result stored in database, billed if applicable
```

---

## Existing Extension Points

### 1. Adapter Registry (`/workspace/server/src/adapters/registry.ts`)

```typescript
const adaptersByType = new Map<string, ServerAdapterModule>();

function registerBuiltInAdapters() {
  for (const adapter of [
    // Add new adapters here
    ollamaLocalAdapter,
    lmStudioLocalAdapter,
    openrouterAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}
```

### 2. Plugin Loader (`/workspace/server/src/adapters/plugin-loader.ts`)

External adapters can be loaded from npm packages.

### 3. Built-in Adapter Types (`/workspace/server/src/adapters/builtin-adapter-types.ts`)

Defines which adapter types are considered "built-in" vs external.

### 4. Model Discovery

Adapters can implement:
- `models?: AdapterModel[]` - Static model list
- `listModels?: () => Promise<AdapterModel[]>` - Dynamic model discovery
- `refreshModels?: () => Promise<AdapterModel[]>` - Cache bypass refresh

### 5. Environment Testing

Adapters implement `testEnvironment()` for connection validation.

### 6. Skill Management

Adapters can implement `listSkills()` and `syncSkills()` for managing agent skills.

---

## Key Findings

1. **Adapters Already Exist**: Ollama, LM Studio, and OpenRouter adapters are fully implemented but not registered.

2. **Registration Required**: To enable these adapters, they need to be:
   - Imported in `/workspace/server/src/adapters/registry.ts`
   - Added to the `registerBuiltInAdapters()` function
   - Optionally added to built-in types list

3. **Missing Features**:
   - Ollama: Missing `testEnvironment()` export in server/index.ts (file doesn't exist)
   - LM Studio: Has `testEnvironment()` but may need model listing
   - OpenRouter: May need `testEnvironment()` implementation

4. **OpenAI-Compatible Refactor Opportunity**: LM Studio and OpenRouter share identical request/response patterns and could share a common base utility.

5. **UI Integration**: Provider labels exist in utils.ts, but full UI support needs verification.

---

## Next Steps

1. Verify adapter implementations are complete
2. Create missing test.ts files where needed
3. Register adapters in registry.ts
4. Update builtin-adapter-types.ts
5. Test end-to-end functionality
6. Update documentation
