/** Cursor catalog id for Agents Window "Auto". */
export const AUTO_MODEL_ID = "default";

export function isAutoModelId(id: string | null | undefined): boolean {
  if (!id) return true;
  const t = id.trim().toLowerCase();
  return t === AUTO_MODEL_ID || t === "inherit" || t === "auto";
}

/** User tokens like `auto` → catalog id. */
export function normalizeModelToken(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t === "auto" || t === "inherit" || t === AUTO_MODEL_ID) return AUTO_MODEL_ID;
  return raw.trim();
}

/**
 * Model id for SDK Agent.create / send.
 * Auto must be explicit `default` — omitting model uses the account default (e.g. opus), not Auto.
 */
export function effectiveModelForSend(
  preferred: string | null | undefined,
): string {
  if (isAutoModelId(preferred)) return AUTO_MODEL_ID;
  return preferred!.trim();
}
