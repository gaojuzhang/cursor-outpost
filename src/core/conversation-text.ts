import type { Conversation } from "../cursor/types.js";

/** Assistant reply immediately after a user message id. */
export function assistantFollowingUserMessage(
  conv: Conversation,
  userMsgId: string,
): string | undefined {
  const msgs = conv.messages;
  const idx = msgs.findIndex((m) => m.id === userMsgId);
  if (idx < 0) return undefined;
  for (let i = idx + 1; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.type === "assistant_message") return (m.text ?? "").trim() || undefined;
    if (m.type === "user_message") break;
  }
  return undefined;
}

/** Match the latest user_message with this exact prompt text (Telegram outbound). */
export function assistantFollowingPromptText(
  conv: Conversation,
  promptText: string,
): string | undefined {
  const needle = promptText.trim();
  if (!needle) return undefined;
  const msgs = conv.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.type === "user_message" && promptMatchesUserText(needle, m.text ?? "")) {
      return assistantFollowingUserMessage(conv, m.id);
    }
  }
  return undefined;
}

/** Assistant reply after the most recent user_message (any text). */
export function assistantFollowingLastUserMessage(
  conv: Conversation,
): string | undefined {
  const msgs = conv.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.type === "user_message") {
      return assistantFollowingUserMessage(conv, m.id);
    }
  }
  return undefined;
}

function promptMatchesUserText(needle: string, userText: string): boolean {
  const t = userText.trim();
  if (!t) return false;
  if (t === needle) return true;
  if (t.includes(needle) || needle.includes(t)) return true;
  return false;
}

export function lastAssistantText(conv: Conversation): string | undefined {
  const assistants = conv.messages.filter((m) => m.type === "assistant_message");
  const last = assistants[assistants.length - 1];
  return last?.text?.trim() || undefined;
}
