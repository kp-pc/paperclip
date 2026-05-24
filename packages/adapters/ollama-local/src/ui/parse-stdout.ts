import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    // Non-JSON line, treat as raw stdout
    const trimmed = line.trim();
    if (!trimmed) return [];
    return [{ kind: "stdout", ts, text: trimmed }];
  }
  
  // Ollama streaming response format
  const message = asRecord(parsed.message);
  if (message) {
    const content = asString(message.content, "");
    if (content) {
      return [{ kind: "assistant", ts, text: content, delta: true }];
    }
  }
  
  // Check for done signal
  const done = parsed.done;
  if (done === true || done === "true") {
    const evalCount = typeof parsed.eval_count === "number" ? parsed.eval_count : 0;
    const promptEvalCount = typeof parsed.prompt_eval_count === "number" ? parsed.prompt_eval_count : 0;
    
    if (evalCount > 0 || promptEvalCount > 0) {
      return [{
        kind: "result",
        ts,
        text: "Run completed",
        inputTokens: promptEvalCount,
        outputTokens: evalCount,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "end",
        isError: false,
        errors: [],
      }];
    }
  }
  
  // Check for error
  const error = asString(parsed.error, "");
  if (error) {
    return [{
      kind: "result",
      ts,
      text: error,
      subtype: "error",
      isError: true,
      errors: [{ message: error }],
    }];
  }
  
  // Fallback for unknown event types
  return [{ kind: "stdout", ts, text: line }];
}
