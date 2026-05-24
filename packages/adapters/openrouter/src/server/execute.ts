import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { DEFAULT_OPENROUTER_MODEL } from "../index.js";

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
  const model = asString(config.model, DEFAULT_OPENROUTER_MODEL).trim();
  const baseUrl = asString(config.baseUrl, "https://openrouter.ai/api/v1").trim();

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

  // Check for OpenRouter API key
  const openRouterApiKey =
    typeof envConfig.OPENROUTER_API_KEY === "string" && envConfig.OPENROUTER_API_KEY.trim().length > 0
      ? envConfig.OPENROUTER_API_KEY.trim()
      : process.env.OPENROUTER_API_KEY?.trim() || null;

  if (!openRouterApiKey) {
    await onLog("stderr", "[paperclip] Error: OPENROUTER_API_KEY is required but not provided\\n");
    return {
      exitCode: 1,
      stdout: "",
      stderr: "OPENROUTER_API_KEY is required",
      inputTokens: 0,
      outputTokens: 0,
      startTime: Date.now(),
      endTime: Date.now(),
    };
  }

  const mergedEnv = { ...process.env, ...env, OPENROUTER_API_KEY: openRouterApiKey };
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

  const resolvedCommand = "openrouter-api";
  let loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteRuntimeRootDir: string | null = null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

  if (executionTargetIsRemote) {
    try {
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace to ${describeAdapterExecutionTarget(executionTarget)}.\\n`,
      );
      const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "openrouter",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: "echo 'OpenRouter adapter - no sandbox install needed'",
        detectCommand: "curl --version",
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
      await onLog("stderr", `[paperclip] Failed to sync remote runtime: ${err instanceof Error ? err.message : String(err)}\\n`);
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
      await onLog("stderr", `[paperclip] Failed to read instructions file: ${err instanceof Error ? err.message : String(err)}\\n`);
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

  // Build OpenRouter API request (OpenAI-compatible format)
  const openRouterMessages = [
    {
      role: "user" as const,
      content: renderedPrompt,
    },
  ];

  const openRouterRequest = {
    model,
    messages: openRouterMessages,
    stream: true,
  };

  // Execute via OpenRouter API
  const startTime = Date.now();
  let fullContent = "";
  let errorMessage: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    // Use curl to call OpenRouter API directly
    const curlCmd = `curl -s -N -X POST ${shellQuote(baseUrl + "/chat/completions")} -H "Content-Type: application/json" -H "Authorization: Bearer ${openRouterApiKey}" -d ${shellQuote(JSON.stringify(openRouterRequest))}`;

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
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") break;
              try {
                const parsed = JSON.parse(data);
                if (parsed.choices && parsed.choices[0]?.delta?.content) {
                  const content = parsed.choices[0].delta.content;
                  fullContent += content;
                  await onLog("stdout", content);
                }
                if (parsed.usage) {
                  inputTokens = parsed.usage.prompt_tokens || inputTokens;
                  outputTokens = parsed.usage.completion_tokens || outputTokens;
                }
              } catch {
                // Ignore parse errors for partial chunks
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
      errorMessage = `OpenRouter API process exited with code ${proc.exitCode}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] OpenRouter API error: ${errorMessage}\\n`);
  }

  // Cleanup
  if (restoreRemoteWorkspace) {
    try {
      await restoreRemoteWorkspace();
    } catch (err) {
      await onLog("stderr", `[paperclip] Warning: Failed to restore remote workspace: ${err instanceof Error ? err.message : String(err)}\\n`);
    }
  }

  if (paperclipBridge) {
    try {
      await paperclipBridge.cleanup();
    } catch (err) {
      await onLog("stderr", `[paperclip] Warning: Paperclip bridge cleanup failed: ${err instanceof Error ? err.message : String(err)}\\n`);
    }
  }

  const endTime = Date.now();

  await onMeta({
    provider: "openrouter",
    model,
    inputTokens,
    outputTokens,
    durationMs: endTime - startTime,
  });

  return {
    exitCode: errorMessage ? 1 : 0,
    stdout: fullContent,
    stderr: errorMessage || "",
    inputTokens,
    outputTokens,
    startTime,
    endTime,
  };
}

