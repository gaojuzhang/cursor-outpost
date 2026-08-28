import type { ChannelAdapter, OutgoingTarget } from "../channels/types.js";
import {
  augmentWindowUserPromptWithImageNote,
  formatWindowResult,
  formatWindowResultHtml,
  formatWindowUserPhotoCaption,
  formatWindowUserPrompt,
  formatWindowUserPromptHtml,
  formatWindowWorking,
  TELEGRAM_TEXT_LIMIT,
} from "../channels/telegram/format.js";
import type { CursorClient } from "../cursor/client.js";
import {
  isTerminalRunStatus,
  type Conversation,
  type ConversationMessage,
  type PromptImage,
  type Run,
} from "../cursor/types.js";
import type { Store, ThreadRow } from "../store/db.js";
import type { ActiveStreamTracker } from "./active-streams.js";

export type PollerDeps = {
  store: Store;
  cursor: CursorClient;
  channel: ChannelAdapter;
  streams: ActiveStreamTracker;
  intervalMs: number;
};

/** Agent reply suggests the paired user prompt included an image. */
const VISUAL_REPLY_PATTERN =
  /图片|图中|照片|截图|图像|画面上|这张图|这张照片|图示|in the (image|photo|picture)|from the (image|photo|screenshot)/i;

/** Short visual questions often sent with an image caption in Agents Window. */
const SHORT_VISUAL_QUESTION_PATTERN =
  /^(这|那).*(什么|啥)|^(what|what's)/i;

function isLikelyImageCaption(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t.length <= 80 && SHORT_VISUAL_QUESTION_PATTERN.test(t);
}

function getFollowingAssistantText(
  conv: Conversation,
  userMsgId: string,
): string | undefined {
  const msgs = conv.messages;
  const idx = msgs.findIndex((m) => m.id === userMsgId);
  if (idx < 0) return undefined;
  for (let i = idx + 1; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.type === "assistant_message") return (m.text ?? "").trim();
    if (m.type === "user_message") break;
  }
  return undefined;
}

function extractPromptImages(msg: ConversationMessage): PromptImage[] {
  const raw = msg.images;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.filter(
    (img) =>
      typeof img.data === "string" &&
      img.data.length > 0 &&
      typeof img.mimeType === "string" &&
      img.mimeType.length > 0,
  );
}

/**
 * Poll Cloud Agent runs and push Window-originated results back to IM.
 * Echo suppression: runs with origin=telegram (or currently SSE-streaming) are skipped.
 */
export class Poller {
  private readonly store: Store;
  private readonly cursor: CursorClient;
  private readonly channel: ChannelAdapter;
  private readonly streams: ActiveStreamTracker;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /** In-process: already sent "Window run in progress" for this run */
  private readonly announcedRunning = new Set<string>();

  constructor(deps: PollerDeps) {
    this.store = deps.store;
    this.cursor = deps.cursor;
    this.channel = deps.channel;
    this.streams = deps.streams;
    this.intervalMs = deps.intervalMs;
  }

  start(): void {
    if (this.timer) return;
    console.log(`outpost: poller start (interval=${this.intervalMs}ms)`);
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async workUpdate(target: OutgoingTarget, status: string): Promise<void> {
    if (this.channel.updateWork) {
      await this.channel.updateWork(target, status);
    } else {
      await this.channel.sendStatus(target, status);
    }
  }

  private async workEnd(target: OutgoingTarget): Promise<void> {
    if (this.channel.endWork) {
      await this.channel.endWork(target);
    }
  }

  private errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const threads = this.store.listActiveThreadsWithAgent();
      for (const thread of threads) {
        if (!thread.agent_id) continue;
        try {
          await this.syncUserMessages(thread);
        } catch (err) {
          console.error(
            `outpost: poller conversation sync error agent=${thread.agent_id}: ${this.errMessage(err)}`,
          );
        }
        try {
          await this.pollThread(thread);
        } catch (err) {
          console.error(
            `outpost: poller run poll error agent=${thread.agent_id}: ${this.errMessage(err)}`,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Push Window (or other non-bridge) user prompts to IM.
   * v1 runs lack prompt text; use legacy v0 conversation.
   */
  private async syncUserMessages(thread: ThreadRow): Promise<void> {
    const agentId = thread.agent_id!;
    const target: OutgoingTarget = {
      channel: thread.channel as OutgoingTarget["channel"],
      chatId: thread.chat_id,
      threadId: thread.thread_id,
    };

    const conv = await this.cursor.getConversation(agentId);
    const userMsgs = conv.messages.filter(
      (m) => m.type === "user_message" && m.id,
    );

    // First sight of this agent: mark existing history as seen (no flood).
    if (!this.store.hasAnyConversationMessage(agentId)) {
      for (const msg of userMsgs) {
        const text = (msg.text ?? "").trim();
        if (text) this.store.consumeOutboundPrompt(agentId, text);
        this.store.markConversationMessage(msg.id, agentId, msg.type);
      }
      return;
    }

    for (const msg of userMsgs) {
      if (this.store.hasConversationMessage(msg.id)) continue;

      const text = (msg.text ?? "").trim();
      const promptImages = extractPromptImages(msg);
      const following = getFollowingAssistantText(conv, msg.id);

      if (!text && promptImages.length === 0) {
        await this.sendWindowUser(target, text, { hadImage: true, promptImages });
        this.store.markConversationMessage(msg.id, agentId, msg.type);
        continue;
      }

      if (
        text &&
        promptImages.length === 0 &&
        !following &&
        isLikelyImageCaption(text)
      ) {
        // Wait for assistant reply so we can add the image footnote if needed.
        continue;
      }

      // Echo of a prompt we sent from Telegram — mark seen, do not re-push.
      if (text && this.store.consumeOutboundPrompt(agentId, text)) {
        this.store.markConversationMessage(msg.id, agentId, msg.type);
        continue;
      }

      const hadImage =
        promptImages.length > 0 ||
        (following ? VISUAL_REPLY_PATTERN.test(following) : false);

      await this.sendWindowUser(target, text, {
        hadImage,
        promptImages,
      });
      this.store.markConversationMessage(msg.id, agentId, msg.type);
    }
  }

  /** Prefer HTML styling; fall back to plain if the payload exceeds Telegram limit. */
  private async sendWindowUser(
    target: OutgoingTarget,
    text: string,
    opts?: { hadImage?: boolean; promptImages?: PromptImage[] },
  ): Promise<void> {
    const promptImages = opts?.promptImages ?? [];
    const hadImage = opts?.hadImage ?? false;
    const displayText =
      hadImage && promptImages.length === 0
        ? augmentWindowUserPromptWithImageNote(text)
        : text;

    if (promptImages.length > 0 && this.channel.sendPhoto) {
      const img = promptImages[0]!;
      await this.channel.sendPhoto(target, {
        data: img.data,
        mimeType: img.mimeType,
        caption: formatWindowUserPhotoCaption(displayText),
      });
      return;
    }

    const html = formatWindowUserPromptHtml(displayText);
    if (html.length <= TELEGRAM_TEXT_LIMIT) {
      await this.channel.sendText(target, html, { parseMode: "HTML" });
      return;
    }
    await this.channel.sendText(target, formatWindowUserPrompt(displayText));
  }

  private async sendWindowResult(
    target: OutgoingTarget,
    status: string,
    result: string,
    agentUrl: string,
    prUrls: string[],
  ): Promise<void> {
    const html = formatWindowResultHtml(status, result, agentUrl, prUrls);
    if (html.length <= TELEGRAM_TEXT_LIMIT) {
      await this.channel.sendText(target, html, { parseMode: "HTML" });
      return;
    }
    await this.channel.sendText(
      target,
      formatWindowResult(status, result, agentUrl, prUrls),
    );
  }

  private async pollThread(thread: ThreadRow): Promise<void> {
    const agentId = thread.agent_id!;
    const listed = await this.cursor.listRuns(agentId, { limit: 20 });
    const target: OutgoingTarget = {
      channel: thread.channel as OutgoingTarget["channel"],
      chatId: thread.chat_id,
      threadId: thread.thread_id,
    };

    for (const run of listed.items) {
      if (this.streams.isStreaming(agentId, run.id)) {
        continue;
      }

      if (this.store.hasRun(run.id)) {
        const origin = this.store.getRunOrigin(run.id);
        if (origin === "telegram") continue;
        if (origin === "window") {
          await this.maybeDeliverWindowRun(thread, target, run);
        }
        continue;
      }

      // Unknown run → Window (or other non-bridge) origin.
      this.store.insertRun({
        runId: run.id,
        agentId,
        origin: "window",
        channel: thread.channel,
      });
      await this.maybeDeliverWindowRun(thread, target, run);
    }
  }

  private async maybeDeliverWindowRun(
    thread: ThreadRow,
    target: OutgoingTarget,
    run: Run,
  ): Promise<void> {
    if (this.store.isRunNotified(run.id)) return;

    if (!isTerminalRunStatus(run.status)) {
      if (!this.announcedRunning.has(run.id)) {
        this.announcedRunning.add(run.id);
        await this.workUpdate(target, formatWindowWorking());
      }
      return;
    }

    let full = run;
    if (run.result == null) {
      full = await this.cursor.getRun(thread.agent_id!, run.id);
    }

    this.announcedRunning.delete(run.id);
    await this.workEnd(target);

    const prUrls =
      full.git?.branches
        ?.map((b) => b.prUrl)
        .filter((u): u is string => Boolean(u)) ?? [];

    await this.sendWindowResult(
      target,
      full.status,
      full.result ?? "",
      thread.agent_url ?? "",
      prUrls,
    );
    this.store.markRunNotified(run.id);
  }
}
