/** Cursor default when auto-title fails. */
const GENERIC_AGENT_NAME_RE =
  /^(unknown task subject|untitled|new agent|new task)$/i;

export function isGenericAgentName(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  return GENERIC_AGENT_NAME_RE.test(t);
}

/** Title for Agent.create from Telegram / Outpost prompt text. */
export function deriveAgentNameFromPrompt(text: string): string {
  let t = text.trim();
  t = t.replace(/^📷 \[[^\]]+\]\n?/, "");
  const line = t.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!line) return "Telegram image";
  if (line.length <= 100) return line;
  return `${line.slice(0, 97)}…`;
}

export function labelFromConversationText(text: string): string | undefined {
  let t = text.trim();
  if (!t) return undefined;
  t = t.replace(/^📷 \[[^\]]+\]\n?/, "");
  const line = t.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!line) return undefined;
  if (line.length <= 80) return line;
  return `${line.slice(0, 77)}…`;
}

export function agentDisplayLabel(
  name: string,
  summary?: string | null,
  displayName?: string | null,
): string {
  const custom = (displayName ?? "").trim();
  if (custom) return custom;
  const n = name.trim();
  const s = (summary ?? "").trim();
  if (!isGenericAgentName(n)) return n;
  if (s && !isGenericAgentName(s)) return s.length <= 80 ? s : `${s.slice(0, 77)}…`;
  return n || "（未命名）";
}
