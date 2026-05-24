import type { StdoutLineParser, TranscriptEntry } from "@paperclipai/adapter-utils";

export const parseStdout: StdoutLineParser = (line, ts) => {
  // LM Studio outputs streaming chat completions in SSE format
  // Parse data: lines and extract content
  const entries: TranscriptEntry[] = [];
  
  if (!line.trim() || line.startsWith(":")) {
    return entries;
  }
  
  if (line.startsWith("data: ")) {
    const dataStr = line.slice(6);
    if (dataStr === "[DONE]") {
      return entries;
    }
    
    try {
      const parsed = JSON.parse(dataStr);
      const delta = parsed.choices?.[0]?.delta;
      
      if (delta?.content) {
        entries.push({
          kind: "assistant",
          ts,
          text: delta.content,
          delta: true,
        });
      }
      
      if (parsed.usage) {
        // Could add usage tracking here if needed
      }
    } catch {
      // Ignore parse errors for individual chunks
    }
  } else {
    // Non-SSE line - treat as system output
    entries.push({
      kind: "system",
      ts,
      text: line,
    });
  }
  
  return entries;
};
