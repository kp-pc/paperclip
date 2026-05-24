import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printOllamaStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  // Ollama streaming response format
  const message = asRecord(parsed.message);
  if (message) {
    const content = asString(message.content, "");
    if (content) {
      process.stdout.write(pc.green(content));
    }
    return;
  }

  // Check for done signal
  const done = parsed.done;
  if (done === true || done === "true") {
    const evalCount = typeof parsed.eval_count === "number" ? parsed.eval_count : 0;
    const promptEvalCount = typeof parsed.prompt_eval_count === "number" ? parsed.prompt_eval_count : 0;
    if (evalCount > 0 || promptEvalCount > 0) {
      console.log(pc.blue(`\n[Generated ${evalCount} tokens from ${promptEvalCount} prompt tokens]`));
    }
    return;
  }

  // Check for error
  const error = asString(parsed.error, "");
  if (error) {
    console.log(pc.red(`Error: ${error}`));
    return;
  }

  console.log(line);
}
