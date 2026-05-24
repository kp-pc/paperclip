import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { isOllamaConnectionError, isOllamaModelNotFoundError, parseOllamaResponse } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND, DEFAULT_OLLAMA_LOCAL_MODEL } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function testEnvironment(ctx: AdapterExecutionContext): Promise<boolean> {
  const { config, context, onLog } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  
  const command = asString(config.command, "ollama");
  const model = asString(config.model, DEFAULT_OLLAMA_LOCAL_MODEL).trim();
  const baseUrl = asString(config.baseUrl, "http://localhost:11434").trim();
  
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const cwd = workspaceCwd || process.cwd();
  
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  
  // Check if Ollama is accessible
  try {
    const checkCmd = `curl -s ${shellQuote(baseUrl + "/api/tags")} | head -c 100`;
    const result = await runAdapterExecutionTargetShellCommand(
      ctx.runId,
      executionTarget,
      checkCmd,
      {
        cwd,
        env: process.env,
        timeoutSec: Math.min(timeoutSec > 0 ? timeoutSec : 30, 30),
        graceSec,
      },
    );
    
    if (result.exitCode === 0) {
      await onLog("stdout", `✅ Ollama is accessible at ${baseUrl}\n`);
      
      // Check if the model exists
      const listCmd = `curl -s ${shellQuote(baseUrl + "/api/tags")}`;
      const listResult = await runAdapterExecutionTargetShellCommand(
        ctx.runId,
        executionTarget,
        listCmd,
        {
          cwd,
          env: process.env,
          timeoutSec: Math.min(timeoutSec > 0 ? timeoutSec : 30, 30),
          graceSec,
        },
      );
      
      if (listResult.exitCode === 0 && listResult.stdout.includes(model)) {
        await onLog("stdout", `✅ Model "${model}" is available\n`);
        return true;
      } else if (listResult.exitCode === 0) {
        await onLog("stderr", `⚠️  Model "${model}" not found. Available models:\n`);
        try {
          const tags = JSON.parse(listResult.stdout);
          if (tags.models && Array.isArray(tags.models)) {
            for (const m of tags.models) {
              await onLog("stderr", `  - ${m.name}\n`);
            }
          }
        } catch {
          await onLog("stderr", listResult.stdout + "\n");
        }
        return false;
      }
    }
    
    await onLog("stderr", `❌ Failed to connect to Ollama at ${baseUrl}\n`);
    return false;
  } catch (err) {
    await onLog("stderr", `❌ Error testing Ollama connection: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
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
  const command = asString(config.command, "ollama");
  const model = asString(config.model, DEFAULT_OLLAMA_LOCAL_MODEL).trim();
  const baseUrl = asString(config.baseUrl, "http://localhost:11434").trim();
  
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
  
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  let loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });
  
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  
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
        adapterKey: "ollama",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
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
        instructionsText = await fs.readFile(instructionsFilePath, "utf8");
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
  
  // Build Ollama API request
  const ollamaMessages = [
    {
      role: "user" as const,
      content: renderedPrompt,
    },
  ];
  
  const ollamaRequest = {
    model,
    messages: ollamaMessages,
    stream: true,
  };
  
  // Execute via Ollama API
  const startTime = Date.now();
  let fullContent = "";
  let errorMessage: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  
  try {
    // For local execution, use curl to call Ollama API directly
    if (!executionTargetIsRemote) {
      const curlCmd = `curl -s -N -X POST ${shellQuote(baseUrl + "/api/chat")} -H "Content-Type: application/json" -d ${shellQuote(JSON.stringify(ollamaRequest))}`;
      
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
              if (!line.trim()) continue;
              const parsed = parseOllamaResponse(line);
              if (parsed.summary) {
                fullContent += parsed.summary;
                await onLog("stdout", parsed.summary);
              }
              if (parsed.errorMessage) {
                errorMessage = parsed.errorMessage;
              }
              inputTokens = parsed.usage.inputTokens || inputTokens;
              outputTokens = parsed.usage.outputTokens || outputTokens;
            }
          },
          onStderr: async (chunk) => {
            await onLog("stderr", chunk);
          },
        },
      );
      
      if (proc.exitCode !== 0) {
        errorMessage = `Ollama process exited with code ${proc.exitCode}`;
      }
    } else {
      // Remote execution - write request to temp file and execute
      const tempFile = path.posix.join(remoteRuntimeRootDir || "/tmp", `ollama-request-${Date.now()}.json`);
      await ensureAdapterExecutionTargetFile(
        runId,
        executionTarget,
        tempFile,
        JSON.stringify(ollamaRequest),
        runtimeEnv,
        timeoutSec,
        graceSec,
      );
      
      const curlCmd = `curl -s -N -X POST ${shellQuote(baseUrl + "/api/chat")} -H "Content-Type: application/json" -d @${shellQuote(tempFile)}`;
      
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
              if (!line.trim()) continue;
              const parsed = parseOllamaResponse(line);
              if (parsed.summary) {
                fullContent += parsed.summary;
                await onLog("stdout", parsed.summary);
              }
              if (parsed.errorMessage) {
                errorMessage = parsed.errorMessage;
              }
              inputTokens = parsed.usage.inputTokens || inputTokens;
              outputTokens = parsed.usage.outputTokens || outputTokens;
            }
          },
          onStderr: async (chunk) => {
            await onLog("stderr", chunk);
          },
        },
      );
      
      if (proc.exitCode !== 0) {
        errorMessage = `Ollama process exited with code ${proc.exitCode}`;
      }
      
      // Cleanup temp file
      try {
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `rm -f ${shellQuote(tempFile)}`,
          {
            cwd: effectiveExecutionCwd,
            env: runtimeEnv,
            timeoutSec: 10,
            graceSec,
          },
        );
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    if (isOllamaConnectionError(errorMessage)) {
      errorMessage = `Cannot connect to Ollama at ${baseUrl}. Make sure Ollama is running (try: ollama serve)`;
    } else if (isOllamaModelNotFoundError(errorMessage)) {
      errorMessage = `Model "${model}" not found. Try: ollama pull ${model}`;
    }
  }
  
  if (restoreRemoteWorkspace) {
    try {
      await restoreRemoteWorkspace();
    } catch (err) {
      await onLog("stderr", `[paperclip] Warning: failed to restore remote workspace: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  
  if (paperclipBridge) {
    try {
      await paperclipBridge.cleanup();
    } catch (err) {
      await onLog("stderr", `[paperclip] Warning: failed to cleanup Paperclip bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  return {
    summary: fullContent.trim(),
    transcript: [],
    usage: {
      inputTokens,
      outputTokens,
      costUsd: 0,
    },
    meta: {
      model,
      durationMs,
      baseUrl,
    },
    errors: errorMessage ? [{ message: errorMessage }] : [],
  };
}

export { testEnvironment };
