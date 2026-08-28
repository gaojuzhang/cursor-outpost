/** Telegram text formatting helpers (4096 limit, verbose filtering). */

import type { IncomingImage } from "../types.js";

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_STATUS_LIMIT = 200;

export type FormatOptions = {
  /** When false, drop thinking and tool_call content. */
  verbose: boolean;
};

/** Split plain text into Telegram-safe chunks (post-entity limit). */
export function chunkText(
  text: string,
  limit: number = TELEGRAM_TEXT_LIMIT,
): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + limit));
    offset += limit;
  }
  return chunks;
}

/** Thinking text only when verbose. */
export function formatThinking(
  text: string,
  opts: FormatOptions,
): string | undefined {
  if (!opts.verbose) return undefined;
  const t = text.trim();
  if (!t) return undefined;
  return `💭 ${t}`;
}

/**
 * Tool name + status only when verbose.
 * Never include args/result (file bodies / diffs).
 */
export function formatToolCall(
  name: string,
  status: string,
  opts: FormatOptions,
): string | undefined {
  if (!opts.verbose) return undefined;
  const n = name.trim() || "tool";
  const s = status.trim() || "running";
  return `🔧 ${n} — ${s}`;
}

const RUN_STATUS_LABEL: Record<string, string> = {
  CREATING: "Creating",
  RUNNING: "Working",
  FINISHED: "Done",
  ERROR: "Error",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

/** Hermes-style single-line work indicator (for editable status bubble). */
export function formatWorkStatus(phase: string, detail?: string): string {
  const p = phase.trim() || "Working";
  const d = detail?.trim();
  return d ? `⏳ ${p} — ${d}` : `⏳ ${p}`;
}

export function formatRunStatus(status?: string): string {
  const raw = (status ?? "").trim();
  if (!raw) return formatWorkStatus("Working");
  const label = RUN_STATUS_LABEL[raw.toUpperCase()] ?? raw;
  return formatWorkStatus(label);
}

/** @deprecated Prefer formatWorkStatus / formatRunStatus */
export function formatProgressStatus(status?: string): string {
  return formatRunStatus(status);
}

export function formatQueued(queueSize: number): string {
  return `📋 Queued (${queueSize} waiting). Sends when the current run finishes.`;
}

export function formatDrainingQueue(remaining: number): string {
  return formatWorkStatus("Sending queued message", `${remaining} left`);
}

export function formatDoneFooter(
  agentUrl: string,
  prUrls: string[],
  streamedBody: boolean,
): string {
  const lines: string[] = streamedBody ? ["✅ Done"] : [];
  if (!streamedBody) {
    lines.push("✅ Done");
  }
  if (agentUrl) lines.push(agentUrl);
  for (const u of prUrls) lines.push(u);
  return lines.join("\n");
}

export function formatCursorError(message: string): string {
  return `❌ Cursor API error: ${message}`;
}

export function formatStreamError(code: string, message: string): string {
  return `❌ Stream error: ${code} ${message.trim()}`;
}

export function formatPollingFallback(): string {
  return formatWorkStatus("Working", "stream unavailable — polling");
}

/** Mirror of Telegram→Window footnote when API cannot return Window user images. */
export function formatWindowImageSyncNote(): string {
  return "📷 [Agents Window 图片 · Cursor API 不同步，Telegram 无法展示缩略图]";
}

export function augmentWindowUserPromptWithImageNote(text: string): string {
  const note = formatWindowImageSyncNote();
  const body = text.trim();
  return body ? `${note}\n${body}` : note;
}

export function formatWindowUserPrompt(text: string): string {
  return `👤 You · Agents Window\n────────\n${text.trim()}`;
}

/** Plain caption for Telegram photo (Window user prompt). */
export function formatWindowUserPhotoCaption(text: string): string {
  const body = text.trim();
  return body ? `👤 You · Agents Window\n${body}` : "👤 You · Agents Window";
}

export function formatWindowWorking(): string {
  return formatWorkStatus("Agents Window", "run in progress");
}

export function formatWindowResult(
  status: string,
  result: string,
  agentUrl: string,
  prUrls: string[],
): string {
  const body = result.trim() || `(status ${status}, no final text)`;
  const lines = ["🤖 Agent · Agents Window", "────────", body, ""];
  if (agentUrl) lines.push(agentUrl);
  lines.push(...prUrls);
  return lines.join("\n").trimEnd();
}

/** Escape dynamic text for Telegram HTML parse_mode. */
export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** HTML: user prompt from Agents Window (blockquote ≈ distinct bubble). */
export function formatWindowUserPromptHtml(text: string): string {
  const body = escapeTelegramHtml(text.trim());
  return `<b>👤 You · Agents Window</b>\n<blockquote>${body}</blockquote>`;
}

/** HTML: agent reply from Agents Window. */
export function formatWindowResultHtml(
  status: string,
  result: string,
  agentUrl: string,
  prUrls: string[],
): string {
  const body = escapeTelegramHtml(
    result.trim() || `(status ${status}, no final text)`,
  );
  const lines = [`<b>🤖 Agent · Agents Window</b>`, body];
  if (agentUrl) lines.push(escapeTelegramHtml(agentUrl));
  for (const u of prUrls) lines.push(escapeTelegramHtml(u));
  return lines.join("\n");
}

export function formatAgentBusyRetry(): string {
  return formatWorkStatus("Agent busy", "waiting to retry");
}

export function formatNewSession(): string {
  return "🔄 Session cleared (cloud agent not archived). Next message creates a new agent.";
}

export function formatQueueDiscarded(cleared: number): string {
  return `🗑 Discarded ${cleared} queued message(s).`;
}

export function formatCancelNoAgent(): string {
  return "No bound agent in this session.";
}

export function formatCancelNoRun(cleared: number): string {
  if (cleared > 0) {
    return `Cleared ${cleared} queued message(s). No active stream from this bridge.`;
  }
  return "No active stream and queue is empty.";
}

export function formatCancelOk(runId: string, cleared: number): string {
  const base = `⏹ Cancel requested for run ${runId}`;
  return cleared > 0 ? `${base}. Cleared ${cleared} queued message(s).` : base;
}

export function formatCancelNotAllowed(cleared: number): string {
  const base =
    "Cannot cancel: run already finished or not cancellable (409).";
  return cleared > 0
    ? `${base} Cleared ${cleared} queued message(s).`
    : base;
}

export function formatQueueStale(): string {
  return "Queued message dropped: session agent changed.";
}

export function formatPhotoOnlyPrompt(): string {
  return "Please analyze this image.";
}

export function formatPhotoUnsupported(): string {
  return "Could not download the image from Telegram. Try again or send text only.";
}

export function formatImageCorrupt(): string {
  return "Downloaded image data looks invalid. Try sending as Photo (not File) or re-export as JPEG/PNG.";
}

/** Append visible marker into prompt.text so Agents Window history shows image was sent. */
export function augmentPromptWithImageNote(
  text: string,
  images?: IncomingImage[],
): string {
  if (!images?.length) return text.trim();
  const img = images[0]!;
  const kb = Math.max(1, Math.round(img.data.length * 0.75 / 1024));
  const dim =
    img.dimension && img.dimension.width > 0 && img.dimension.height > 0
      ? `${img.dimension.width}×${img.dimension.height}`
      : "";
  const dimPart = dim ? ` ${dim}` : "";
  const n = images.length;
  const note =
    n === 1
      ? `📷 [Telegram 图片 ${img.mimeType}${dimPart} ~${kb}KB · Window 不预览 API 图，Agent 已收到]`
      : `📷 [Telegram 图片 ×${n} ${img.mimeType}${dimPart} ~${kb}KB · Window 不预览 API 图，Agent 已收到]`;
  const body = text.trim();
  return body ? `${note}\n${body}` : note;
}

export function formatUnsupportedImageType(mime: string): string {
  return (
    `Unsupported image type (${mime}). Cursor accepts PNG, JPEG, GIF, WebP only.\n` +
    "Tip: send as Photo (not File) or export as PNG/JPEG."
  );
}
