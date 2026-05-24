import { asString, parseJson } from "@paperclipai/adapter-utils/server-utils";

export function parseOllamaResponse(stdout: string) {
  const lines = stdout.split(/\r?\n/);
  let fullContent = "";
  let model = "";
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let errorMessage: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const error = asString(event.error, "");
    if (error) {
      errorMessage = error;
      continue;
    }

    const responseModel = asString(event.model, "");
    if (responseModel) model = responseModel;

    const message = typeof event.message === "object" && event.message !== null && !Array.isArray(event.message)
      ? event.message as Record<string, unknown>
      : null;
    
    if (message) {
      const content = asString(message.content, "");
      if (content) fullContent += content;
    }

    const done = event.done;
    if (done === true || done === "true") {
      totalPromptTokens = typeof event.prompt_eval_count === "number" ? event.prompt_eval_count : totalPromptTokens;
      totalCompletionTokens = typeof event.eval_count === "number" ? event.eval_count : totalCompletionTokens;
    }
  }

  return {
    summary: fullContent.trim(),
    model,
    usage: {
      inputTokens: totalPromptTokens,
      outputTokens: totalCompletionTokens,
    },
    errorMessage,
  };
}

export function isOllamaConnectionError(stderr: string): boolean {
  const haystack = stderr.toLowerCase();
  return (
    haystack.includes("connection refused") ||
    haystack.includes("failed to connect") ||
    haystack.includes("dial tcp") ||
    haystack.includes("no such host") ||
    haystack.includes("cannot connect to the docker daemon")
  );
}

export function isOllamaModelNotFoundError(stderr: string): boolean {
  const haystack = stderr.toLowerCase();
  return (
    haystack.includes("model not found") ||
    haystack.includes("pull model manifest") ||
    haystack.includes("not found")
  );
}
