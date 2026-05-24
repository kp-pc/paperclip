import type { CLIAdapterModule } from "@paperclipai/adapter-utils";

export const formatStdoutEvent: CLIAdapterModule["formatStdoutEvent"] = (line, debug) => {
  // LM Studio outputs streaming chat completions in SSE format
  // For CLI, we just pass through the content as-is
  if (debug) {
    console.error("[lmstudio-cli]", line);
  } else {
    // Simple passthrough for stdout lines
    if (line.trim()) {
      console.log(line);
    }
  }
};
