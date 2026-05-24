import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    // LM Studio doesn't maintain persistent sessions like Claude/Codex,
    // but we support passing through any session metadata if present.
    const sessionId = readNonEmptyString(record.sessionId);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId);
  },
};

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
