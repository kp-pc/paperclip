import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetFile,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { DEFAULT_LMSTUDIO_LOCAL_MODEL } from "../index.js";

export async function testEnvironment(ctx: {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  executionTarget?: import("@paperclipai/adapter-utils").AdapterExecutionTarget | null;
  environmentName?: string | null;
}): Promise<import("@paperclipai/adapter-utils").AdapterEnvironmentTestResult> {
  const { config } = ctx;
  const baseUrl = asString(config.baseUrl, "http://localhost:1234/v1").trim();
  const model = asString(config.model, DEFAULT_LMSTUDIO_LOCAL_MODEL).trim();
  
  const checks: import("@paperclipai/adapter-utils").AdapterEnvironmentCheck[] = [];
  
  // Check if LM Studio API is accessible
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    
    if (response.ok) {
      checks.push({
        code: "lmstudio_api_accessible",
        level: "info",
        message: `LM Studio API is accessible at ${baseUrl}`,
      });
      
      try {
        const data = await response.json();
        const models = Array.isArray(data.data) ? data.data : [];
        const modelExists = models.some((m: { id?: string }) => m.id === model);
        
        if (modelExists) {
          checks.push({
            code: "lmstudio_model_available",
            level: "info",
            message: `Model "${model}" is available`,
          });
        } else {
          checks.push({
            code: "lmstudio_model_not_found",
            level: "warn",
            message: `Model "${model}" not found in LM Studio`,
            hint: "Make sure a model is loaded in LM Studio",
          });
        }
      } catch {
        checks.push({
          code: "lmstudio_models_parse_error",
          level: "warn",
          message: "Could not parse LM Studio models response",
        });
      }
    } else {
      checks.push({
        code: "lmstudio_api_error",
        level: "error",
        message: `LM Studio API returned status ${response.status}`,
        hint: "Ensure LM Studio local server is running",
      });
    }
  } catch (err) {
    checks.push({
      code: "lmstudio_api_unreachable",
      level: "error",
      message: `Cannot connect to LM Studio at ${baseUrl}`,
      hint: "Ensure LM Studio is running with local server enabled",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  
  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");
  
  return {
    adapterType: ctx.adapterType,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  
  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const model = asString(config.model, DEFAULT_LMSTUDIO_LOCAL_MODEL).trim();
  const baseUrl = asString(config.baseUrl, "http://localhost:1234/v1").trim();
  
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  
  // Build environment
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  
  const mergedEnv = ensurePathInEnv({ ...process.env, ...env });
  const runtimeEnv = Object.fromEntries(
    Object.entries(mergedEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  
  // LM Studio doesn't require CLI installation - it's an API-based adapter
  // Skip command resolution for local execution
  
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  
  if (executionTargetIsRemote) {
    try {
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "lmstudio",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: null,
        detectCommand: null,
        assets: [],
        onLog,
      });
      remoteRuntimeRootDir = preparedRemoteRuntime.remoteRuntimeRootDir;
      restoreRemoteWorkspace = preparedRemoteRuntime.restore;
      effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, preparedRemoteRuntime.remoteWorkspaceDir);
      
      if (adapterExecutionTargetUsesPaperclipBridge(executionTarget)) {
        paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
          runId,
          target: executionTarget,
          authToken,
          localWorkspaceDir: cwd,
          remoteWorkspaceDir: preparedRemoteRuntime.remoteWorkspaceDir,
          timeoutSec,
          graceSec,
          onLog,
        });
      }
    } catch (err) {
      await onLog("stderr", `[paperclip] Failed to sync remote runtime: ${err instanceof Error ? err.message : String(err)}\n`);
      throw err;
    }
  }
  
  // Build the prompt
  const instructionsFilePath = asString(config.instructionsFilePath, "");
  let instructionsText = "";
  if (instructionsFilePath) {
    try {
      if (executionTargetIsRemote) {
        const instrResult = await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `cat ${shellQuote(instructionsFilePath)}`,
          {
            cwd: effectiveExecutionCwd,
            env: runtimeEnv,
            timeoutSec: Math.min(timeoutSec > 0 ? timeoutSec : 30, 30),
            graceSec,
          },
        );
        if (instrResult.exitCode === 0) {
          instructionsText = instrResult.stdout;
        }
      } else {
        instructionsText = await import("node:fs/promises").then((fs) => fs.readFile(instructionsFilePath, "utf8"));
      }
    } catch (err) {
      await onLog("stderr", `[paperclip] Failed to read instructions file: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  
  const wakePrompt = renderPaperclipWakePrompt(context);
  const promptParts: string[] = [];
  if (instructionsText) promptParts.push(instructionsText);
  if (wakePrompt) promptParts.push(wakePrompt);
  promptParts.push(context.prompt || "");
  const finalPrompt = joinPromptSections(promptParts);
  
  const renderedPrompt = renderTemplate(promptTemplate, {
    prompt: finalPrompt,
    runId,
    model,
    baseUrl,
  });
  
  // Build LM Studio API request (OpenAI-compatible format)
  const messages = [
    {
      role: "user" as const,
      content: renderedPrompt,
    },
  ];
  
  const requestBody = {
    model,
    messages,
    stream: true,
  };
  
  // Execute via LM Studio API
  const startTime = Date.now();
  let fullContent = "";
  let errorMessage: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  
  try {
    if (!executionTargetIsRemote) {
      // Local execution - use Node.js fetch directly
      const controller = new AbortController();
      const timeoutId = timeoutSec > 0 
        ? setTimeout(() => controller.abort(), timeoutSec * 1000)
        : undefined;
      
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        
        if (timeoutId) clearTimeout(timeoutId);
        
        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          errorMessage = `LM Studio API returned status ${response.status}: ${errorText}`;
        } else if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split(/\r?\n/);
            
            for (const line of lines) {
              if (!line.trim() || line.startsWith(":")) continue;
              
              if (line.startsWith("data: ")) {
                const dataStr = line.slice(6);
                if (dataStr === "[DONE]") break;
                
                try {
                  const parsed = JSON.parse(dataStr);
                  const delta = parsed.choices?.[0]?.delta;
                  
                  if (delta?.content) {
                    fullContent += delta.content;
                    await onLog("stdout", delta.content);
                  }
                  
                  if (parsed.usage) {
                    inputTokens = parsed.usage.prompt_tokens || inputTokens;
                    outputTokens = parsed.usage.completion_tokens || outputTokens;
                  }
                } catch {
                  // Ignore parse errors for individual chunks
                }
              }
            }
          }
        }
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
          errorMessage = `Request timed out after ${timeoutSec}s`;
        } else {
          errorMessage = `Failed to connect to LM Studio: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } else {
      // Remote execution - write request to temp file and use curl
      const tempFile = `${remoteRuntimeRootDir || "/tmp"}/lmstudio-request-${Date.now()}.json`;
      await ensureAdapterExecutionTargetFile(
        runId,
        executionTarget,
        tempFile,
        JSON.stringify(requestBody),
        runtimeEnv,
        timeoutSec,
        graceSec,
      );
      
      const curlCmd = `curl -s -N -X POST ${shellQuote(baseUrl + "/chat/completions")} -H "Content-Type: application/json" -d @${shellQuote(tempFile)}`;
      
      const proc = await runAdapterExecutionTargetProcess(
        runId,
        executionTarget,
        {
          command: "sh",
          args: ["-c", curlCmd],
          cwd: effectiveExecutionCwd,
          env: runtimeEnv,
        },
        {
          timeoutSec,
          graceSec,
          onSpawn,
          onStdout: async (chunk) => {
            const lines = chunk.split(/\r?\n/);
            for (const line of lines) {
              if (!line.trim() || line.startsWith(":")) continue;
              
              if (line.startsWith("data: ")) {
                const dataStr = line.slice(6);
                if (dataStr === "[DONE]") break;
                
                try {
                  const parsed = JSON.parse(dataStr);
                  const delta = parsed.choices?.[0]?.delta;
                  
                  if (delta?.content) {
                    fullContent += delta.content;
                    await onLog("stdout", delta.content);
                  }
                  
                  if (parsed.usage) {
                    inputTokens = parsed.usage.prompt_tokens || inputTokens;
                    outputTokens = parsed.usage.completion_tokens || outputTokens;
                  }
                } catch {
                  // Ignore parse errors
                }
              }
            }
          },
          onStderr: async (chunk) => {
            await onLog("stderr", chunk);
          },
        },
      );
      
      if (proc.exitCode !== 0) {
        errorMessage = `LM Studio request exited with code ${proc.exitCode}`;
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  
  // Cleanup remote resources
  if (restoreRemoteWorkspace) {
    try {
      await restoreRemoteWorkspace();
    } catch (err) {
      await onLog("stderr", `[paperclip] Warning: failed to restore remote workspace: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  
  if (paperclipBridge) {
    try {
      await paperclipBridge.stop();
    } catch (err) {
      await onLog("stderr", `[paperclip] Warning: paperclip bridge cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  
  const usage = inputTokens > 0 || outputTokens > 0
    ? { inputTokens, outputTokens }
    : undefined;
  
  return {
    exitCode: errorMessage ? 1 : 0,
    signal: null,
    timedOut: false,
    errorMessage: errorMessage ?? null,
    errorCode: errorMessage ? "lmstudio_api_error" : null,
    usage,
    model,
    provider: "lmstudio",
    biller: "local",
    billingType: "unknown" as const,
    costUsd: null,
    summary: fullContent || null,
  };
}
