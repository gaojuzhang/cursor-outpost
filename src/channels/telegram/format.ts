/** Telegram text formatting helpers (4096 limit, verbose filtering). */

import { agentDisplayLabel } from "../../core/agent-label.js";
import { AUTO_MODEL_ID, isAutoModelId } from "../../core/model-prefs.js";
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

/** Separator before the live / done tail on assistant reply messages. */
export const MESSAGE_TAIL_SEP = "\n\n────────\n";

/** Trailing ⏳ line while a run is in progress (appended to the last reply). */
export function formatActiveTail(label: string, detail?: string): string {
  const d = detail?.trim();
  const line = d ? `⏳ ${label} — ${d}` : `⏳ ${label}`;
  return `${MESSAGE_TAIL_SEP}${line}`;
}

export function formatRunActiveTail(status?: string): string {
  const raw = (status ?? "").trim();
  if (!raw) return formatActiveTail("Working");
  const label = RUN_STATUS_LABEL[raw.toUpperCase()] ?? raw;
  return formatActiveTail(label);
}

/** Done + links when there is no assistant body (status bubble only). */
export function formatDoneTail(agentUrl: string, prUrls: string[]): string {
  const lines: string[] = ["✅ Done"];
  if (agentUrl) lines.push(agentUrl);
  for (const u of prUrls) lines.push(u);
  return lines.join("\n");
}

/** Done + links appended to the last assistant message body. */
export function formatContentDoneTail(agentUrl: string, prUrls: string[]): string {
  return `${MESSAGE_TAIL_SEP}${formatDoneTail(agentUrl, prUrls)}`;
}

/** HTML variant for parse_mode=HTML assistant messages. */
export function formatContentDoneTailHtml(
  agentUrl: string,
  prUrls: string[],
): string {
  const lines = ["✅ Done"];
  if (agentUrl) {
    lines.push(
      `<a href="${escapeTelegramHtml(agentUrl)}">${escapeTelegramHtml(agentUrl)}</a>`,
    );
  }
  for (const u of prUrls) {
    lines.push(
      `<a href="${escapeTelegramHtml(u)}">${escapeTelegramHtml(u)}</a>`,
    );
  }
  return `${MESSAGE_TAIL_SEP}${lines.join("\n")}`;
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

export function formatRunBodyUnavailable(): string {
  return "(Reply text not available via API — open the agent link below.)";
}

export function formatContextSummarizing(): string {
  return "Context compressing — summarizing history…";
}

export function formatContextSummarized(): string {
  return "Context compressed — continuing with summarized history.";
}

export function formatContextNearlyFull(pct: number, tokens: number): string {
  return `Context nearly full (~${pct}%, ~${formatContextTokenCount(tokens)} tokens) — auto-summarize may run soon.`;
}

export function formatContextUsageNote(pct: number, tokens: number): string {
  return `Context ~${pct}% (~${formatContextTokenCount(tokens)} tokens this turn).`;
}

function formatContextTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
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

function isFailureRunStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s === "ERROR" || s === "EXPIRED" || s === "CANCELLED";
}

export function formatWindowResultFallbackBody(status: string): string {
  return isFailureRunStatus(status)
    ? "Run failed (no error text from API)."
    : `(status ${status}, no final text)`;
}

export function formatWindowResultBody(status: string, result: string): string {
  const body = result.trim() || formatWindowResultFallbackBody(status);
  return ["🤖 Agent · Agents Window", "────────", body].join("\n");
}

export { isFailureRunStatus };

export function formatWindowResult(
  status: string,
  result: string,
  agentUrl: string,
  prUrls: string[],
): string {
  const body = result.trim() || formatWindowResultFallbackBody(status);
  const lines = ["🤖 Agent · Agents Window", "────────", body, ""];
  if (agentUrl) lines.push(agentUrl);
  lines.push(...prUrls);
  return lines.join("\n").trimEnd();
}

import { markdownToTelegramHtml } from "./markdown.js";
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
  const body = result.trim()
    ? markdownToTelegramHtml(result.trim())
    : escapeTelegramHtml(formatWindowResultFallbackBody(status));
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

export function formatBindUsage(): string {
  return (
    "用法：/repos 查看列表 → /bind <序号|仓库名>\n" +
    "换绑：/bind <序号|仓库名> confirm\n" +
    "默认分支：main（可在 agent 内 git checkout）"
  );
}

export function formatBindCurrentBinding(opts: {
  slug: string;
  repoUrl: string;
  ref: string;
  agentId?: string | null;
}): string {
  const agent = opts.agentId
    ? `\n当前 agent：${opts.agentId}`
    : "\n当前 agent：（无，下条消息将创建）";
  return (
    `📌 本 topic 已绑定\n` +
    `项目：${opts.slug}\n` +
    `${opts.repoUrl}@${opts.ref}` +
    agent +
    `\n\n更换项目：/bind <slug>（需二次确认）\n` +
    `查看可选：/bind`
  );
}

export function formatBindAlreadyBound(opts: {
  slug: string;
  repoUrl: string;
  ref: string;
  agentId?: string | null;
}): string {
  const agent = opts.agentId ? `\nagent：${opts.agentId}` : "";
  return (
    `✓ 已绑定到 ${opts.slug}（${opts.repoUrl}@${opts.ref}）${agent}\n` +
    "无需重复绑定。换项目请 /bind <其他 slug>"
  );
}

export function formatBindConfirmRequired(opts: {
  currentSlug: string;
  currentRepo: string;
  currentRef: string;
  currentAgentId?: string | null;
  newSlug: string;
  newRepo: string;
  newRef: string;
}): string {
  const agent = opts.currentAgentId
    ? `\n当前 agent：${opts.currentAgentId}`
    : "";
  return (
    `⚠️ 本 topic 已绑定 ${opts.currentSlug}\n` +
    `${opts.currentRepo}@${opts.currentRef}${agent}\n\n` +
    `若改绑到 ${opts.newSlug}（${opts.newRepo}@${opts.newRef}）：\n` +
    "· 本地 agent 映射会清空，下条消息新建 Cloud Agent\n" +
    "· /resume 按项目过滤的列表可能和旧会话不一致\n\n" +
    `确认请发送：/bind ${opts.newSlug} confirm`
  );
}

export function formatBindOk(opts: {
  slug: string;
  repoUrl: string;
  ref: string;
  clearedAgent: boolean;
}): string {
  const cleared = opts.clearedAgent
    ? "\n（已清空原 agent 映射；下条消息将创建新 agent。）"
    : "";
  return `✅ 已绑定到 ${opts.slug}\n${opts.repoUrl}@${opts.ref}${cleared}`;
}

export function formatRepoListHeader(opts: {
  count: number;
  syncedAt: number | null;
  forced: boolean;
  fromCache: boolean;
}): string {
  const when =
    opts.syncedAt != null
      ? new Date(opts.syncedAt).toLocaleString("zh-CN", { hour12: false })
      : "never";
  const refresh = opts.forced ? "（已强制刷新）" : "";
  const cache = opts.fromCache && !opts.forced ? "（缓存）" : "";
  return (
    `📦 Cursor 已连接 GitHub 仓库 · ${opts.count} 条\n` +
    `缓存 ${when}${refresh}${cache}\n` +
    "来源：Cursor GitHub App，非 GitHub 全量列表"
  );
}

export function formatRepoListEntryHtml(
  index: number,
  url: string,
  slug: string,
): string {
  const u = escapeTelegramHtml(url);
  const s = escapeTelegramHtml(slug);
  return `<b>${index}. ${s}</b>\n<code>${u}</code>`;
}

export function formatRepoListFooter(): string {
  return (
    "/bind &lt;序号&gt; 或 /bind &lt;仓库名&gt; 绑定本 topic\n" +
    "换绑：/bind … confirm · /repos refresh 强制刷新"
  );
}

export function formatRepoListEmpty(): string {
  return "（空 — 在 Cursor 连接 GitHub 后 /repos refresh）";
}

export function formatAgentDeleted(): string {
  return "⚠️ Cloud agent was deleted or archived in Cursor. Session cleared — next message creates a new agent.";
}

export function formatSessionListHeader(opts: {
  projectSlug?: string;
  syncedAt: number | null;
  count: number;
  forced: boolean;
}): string {
  const when =
    opts.syncedAt != null
      ? new Date(opts.syncedAt).toLocaleString("zh-CN", { hour12: false })
      : "never";
  const refresh = opts.forced ? "（已强制刷新）" : "";
  const proj = opts.projectSlug ? ` · 项目 ${opts.projectSlug}` : "";
  return `📋 Cloud Agents${proj} · ${opts.count} 条 · 缓存 ${when}${refresh}\n★ = 当前绑定 · † = archived\n`;
}

export function formatSessionListHeaderHtml(opts: {
  projectSlug?: string;
  syncedAt: number | null;
  count: number;
  forced: boolean;
}): string {
  const when =
    opts.syncedAt != null
      ? new Date(opts.syncedAt).toLocaleString("zh-CN", { hour12: false })
      : "never";
  const refresh = opts.forced ? "（已强制刷新）" : "";
  const proj = opts.projectSlug
    ? ` · 项目 ${escapeTelegramHtml(opts.projectSlug)}`
    : "";
  return (
    `<b>📋 Cloud Agents</b>${proj} · ${opts.count} 条\n` +
    `缓存 ${escapeTelegramHtml(when)}${escapeTelegramHtml(refresh)}\n` +
    "★ = 当前绑定 · † = archived"
  );
}

type SessionListRow = {
  agent_id: string;
  name: string;
  summary: string;
  display_name?: string | null;
  status: string | null;
  archived: number;
  repos_json: string | null;
  last_modified: number;
};

const SESSION_COL_NO = 4;
const SESSION_COL_UPDATED = 14;
const SESSION_COL_STATUS = 10;
const SESSION_COL_TITLE = 24;

function padSessionCol(text: string, width: number): string {
  if (text.length > width) {
    return text.slice(0, width - 1) + "…";
  }
  return text.padEnd(width, " ");
}

function formatSessionUpdated(ts: number): string {
  if (!ts || ts <= 0) return "-";
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

/** Short status label for /resume table (SDK: running / finished / error). */
export function formatAgentListStatus(
  status: string | null | undefined,
  archived: boolean,
): string {
  if (archived) return "archived";
  const s = (status ?? "").trim().toLowerCase();
  if (s === "running") return "running";
  if (s === "finished") return "finished";
  if (s === "error") return "error";
  if (s === "creating") return "creating";
  if (s === "cancelled") return "cancelled";
  if (s === "expired") return "expired";
  if (!s) return "-";
  return s.slice(0, SESSION_COL_STATUS);
}

function buildSessionTableLines(
  rows: SessionListRow[],
  currentAgentId?: string,
): string[] {
  const header =
    padSessionCol("#", SESSION_COL_NO) +
    padSessionCol("更新", SESSION_COL_UPDATED) +
    padSessionCol("状态", SESSION_COL_STATUS) +
    padSessionCol("名称", SESSION_COL_TITLE);
  const sep = "-".repeat(header.length);
  const lines = [header, sep];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const star = row.agent_id === currentAgentId ? "★" : "";
    const idx = `${i + 1}${star}`;
    const title = agentDisplayLabel(row.name, row.summary, row.display_name);
    const arch = row.archived ? "†" : "";
    const st = formatAgentListStatus(row.status, row.archived !== 0).slice(
      0,
      SESSION_COL_STATUS,
    );
    lines.push(
      padSessionCol(idx, SESSION_COL_NO) +
        padSessionCol(formatSessionUpdated(row.last_modified), SESSION_COL_UPDATED) +
        padSessionCol(st, SESSION_COL_STATUS) +
        padSessionCol(title + arch, SESSION_COL_TITLE),
    );
    lines.push(`    ${row.agent_id}`);
  }
  return lines;
}

export function formatSessionListTableHtml(
  rows: SessionListRow[],
  currentAgentId?: string,
): string {
  const lines = buildSessionTableLines(rows, currentAgentId);
  return `<pre>${escapeTelegramHtml(lines.join("\n"))}</pre>`;
}

/** Split wide table into multiple &lt;pre&gt; blocks when one message would be too long. */
export function formatSessionListTableHtmlChunks(
  rows: SessionListRow[],
  currentAgentId?: string | undefined,
  maxPreChars = 3500,
): string[] {
  if (rows.length === 0) return [];
  const chunks: string[] = [];
  let batch: SessionListRow[] = [];
  for (const row of rows) {
    batch.push(row);
    const html = formatSessionListTableHtml(batch, currentAgentId);
    const preLen = html.length - "<pre></pre>".length;
    if (preLen > maxPreChars && batch.length > 1) {
      const last = batch.pop()!;
      chunks.push(formatSessionListTableHtml(batch, currentAgentId));
      batch = [last];
    }
  }
  if (batch.length > 0) {
    chunks.push(formatSessionListTableHtml(batch, currentAgentId));
  }
  return chunks;
}

export function formatSessionListEntry(
  index: number,
  row: SessionListRow,
  currentAgentId?: string,
): string {
  const star = row.agent_id === currentAgentId ? "★ " : "";
  const arch = row.archived ? " [archived]" : "";
  const st = formatAgentListStatus(row.status, row.archived !== 0);
  const title = agentDisplayLabel(row.name, row.summary, row.display_name);
  const updated = formatSessionUpdated(row.last_modified);
  const repo = sessionListRepoShort(row.repos_json);
  const meta = repo ? `${st} · ${updated} · ${repo}` : `${st} · ${updated}`;
  return `${index}. ${star}${title}${arch}\n${row.agent_id}\n${meta}`;
}

export function formatSessionListEntryHtml(
  index: number,
  row: SessionListRow,
  currentAgentId?: string,
): string {
  const star = row.agent_id === currentAgentId ? "★ " : "";
  const arch = row.archived ? " <i>[archived]</i>" : "";
  const title = escapeTelegramHtml(
    agentDisplayLabel(row.name, row.summary, row.display_name),
  );
  const st = escapeTelegramHtml(
    formatAgentListStatus(row.status, row.archived !== 0),
  );
  const updated = escapeTelegramHtml(formatSessionUpdated(row.last_modified));
  const repo = sessionListRepoShort(row.repos_json);
  const repoPart = repo ? ` · ${escapeTelegramHtml(repo)}` : "";
  const id = escapeTelegramHtml(row.agent_id);
  return (
    `<b>${index}. ${star}${title}</b>${arch}\n` +
    `<code>${id}</code>\n` +
    `${st} · ${updated}${repoPart}`
  );
}

function sessionListRepoShort(reposJson: string | null): string {
  if (!reposJson) return "";
  try {
    const repos = JSON.parse(reposJson) as string[];
    const r = repos[0];
    if (!r) return "";
    return r.replace(/^https?:\/\//, "").split("/").slice(-2).join("/");
  } catch {
    return "";
  }
}

export function formatSessionListFooter(): string {
  return "\n/resume <序号> 或 /resume bc-… 切换\n/resume refresh 强制从 Cursor 拉取列表";
}

export function formatSessionListFooterHtml(): string {
  return (
    "/resume &lt;序号&gt; 或 /resume bc-… 切换\n" +
    "/resume refresh 强制从 Cursor 拉取列表"
  );
}

export function formatSessionResumed(name: string, agentUrl: string): string {
  return `✅ 已切换会话：${name}\n${agentUrl}\n下一条消息将 follow-up 到此 agent。`;
}

export function formatSessionNotFound(token: string): string {
  return `未找到会话「${token}」。先 /resume 查看列表，或 /resume refresh 刷新。`;
}

export function formatSessionRefreshOk(count: number): string {
  return `已刷新 ${count} 个 Cloud Agent。`;
}

export function formatSessionCacheFresh(): string {
  return "缓存仍新鲜，未请求远程（用 /resume refresh 强制刷新）。";
}

export function formatModelListHeader(opts: {
  preferenceLabel: string;
  agentModelLabel?: string;
  forced?: boolean;
}): string {
  const refresh = opts.forced ? "（已刷新）" : "";
  const agent = opts.agentModelLabel
    ? `\nAgent 当前：${opts.agentModelLabel}`
    : "";
  return `🤖 模型${refresh}\n会话偏好：${opts.preferenceLabel}${agent}\n`;
}

export function formatModelListEntry(
  index: number,
  id: string,
  displayName: string,
  preferredId: string | null,
): string {
  const isCurrent =
    (isAutoModelId(preferredId) && id === AUTO_MODEL_ID) ||
    preferredId === id;
  const mark = isCurrent ? "★ " : "";
  const idPart = id === AUTO_MODEL_ID ? "" : ` · ${id}`;
  return `${index}. ${mark}${displayName}${idPart}`;
}

export function formatModelListFooter(): string {
  return "\n/model auto · /model <序号> · /model <id>\n/model refresh 刷新列表";
}

export function formatModelSet(label: string): string {
  return `✅ 模型已设为 ${label}`;
}

export function formatModelNotFound(token: string): string {
  return `未找到模型「${token}」。/model 查看列表。`;
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
