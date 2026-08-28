import type { ChannelAdapter, OutgoingTarget } from "../channels/types.js";
import {
  augmentWindowUserPromptWithImageNote,
  formatRunBodyUnavailable,
  formatWindowUserPhotoCaption,
  formatWindowUserPrompt,
  formatWindowUserPromptHtml,
  formatAgentDeleted,
  formatWindowWorking,
  isFailureRunStatus,
  TELEGRAM_TEXT_LIMIT,
} from "../channels/telegram/format.js";
import { assistantFollowingUserMessage } from "../core/conversation-text.js";
import { isStaleAgentError, type CursorClient } from "../cursor/client.js";
import {
  isTerminalRunStatus,
  type Conversation,
  type ConversationMessage,
  type PromptImage,
  type Run,
} from "../cursor/types.js";
import type { Store, ThreadRow } from "../store/db.js";
import type { ActiveStreamTracker } from "./active-streams.js";
import { RunBodyResolver } from "../delivery/run-body-resolver.js";
import { prUrlsFromGit } from "../delivery/run-outcome.js";
import { TelegramRunPresenter } from "../delivery/telegram-presenter.js";

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
  return assistantFollowingUserMessage(conv, userMsgId);
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
  private readonly presenter: TelegramRunPresenter;
  private readonly runBodyResolver: RunBodyResolver;
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
    this.presenter = new TelegramRunPresenter(this.channel);
    this.runBodyResolver = new RunBodyResolver({
      cursor: this.cursor,
      getOutboundPromptText: (agentId, runId) =>
        this.store.getOutboundPromptText(agentId, runId),
    });
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

  private errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Clear binding when Cursor reports agent deleted/archived; notify once. */
  private async maybeHandleStaleAgent(
    thread: ThreadRow,
    err: unknown,
  ): Promise<boolean> {
    if (!isStaleAgentError(err) || !thread.agent_id) return false;
    const agentId = thread.agent_id;
    console.log(
      `outpost: agent ${agentId} no longer available — clearing thread binding`,
    );
    this.cursor.clearAgentCache(agentId);
    this.store.clearAgentSyncState(agentId);
    this.streams.clearAgent(agentId);
    this.store.resetThreadAgent(thread.channel, thread.chat_id, thread.thread_id);
    const target: OutgoingTarget = {
      channel: thread.channel as OutgoingTarget["channel"],
      chatId: thread.chat_id,
      threadId: thread.thread_id,
    };
    await this.channel.sendText(target, formatAgentDeleted());
    return true;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const threads = this.store.listActiveThreadsWithAgent();
      for (const thread of threads) {
        if (!thread.agent_id) continue;
        let stale = false;
        try {
          await this.syncUserMessages(thread);
        } catch (err) {
          if (await this.maybeHandleStaleAgent(thread, err)) stale = true;
          else {
            console.error(
              `outpost: poller conversation sync error agent=${thread.agent_id}: ${this.errMessage(err)}`,
            );
          }
        }
        if (stale) continue;
        try {
          await this.pollThread(thread);
        } catch (err) {
          if (await this.maybeHandleStaleAgent(thread, err)) continue;
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
      if (this.store.hasConversationMessage(msg.id, agentId)) continue;

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

  private async resolveRunSnapshot(agentId: string, run: Run): Promise<Run> {
    if (run.result != null || !isTerminalRunStatus(run.status)) return run;
    return this.cursor.getRun(agentId, run.id);
  }

  /** Orphan API failures (never showed Window working) — do not push to IM. */
  private shouldAbsorbSilentRun(run: Run): boolean {
    if (!isTerminalRunStatus(run.status)) return false;
    if (this.announcedRunning.has(run.id)) return false;
    return isFailureRunStatus(run.status) && !run.result?.trim();
  }

  private absorbRun(
    agentId: string,
    runId: string,
    channel: string,
    reason: string,
  ): void {
    this.store.insertRun({
      runId,
      agentId,
      origin: "window",
      channel,
    });
    this.store.markRunNotified(runId);
    console.log(`outpost: poller absorbed run ${runId} agent=${agentId} (${reason})`);
  }

  private async resolveWindowResultText(
    agentId: string,
    run: Run,
  ): Promise<string> {
    if (run.result?.trim()) return run.result.trim();

    const outcome = await this.runBodyResolver.resolve({
      agentId,
      runId: run.id,
      streamBuffer: "",
      gitHint: run.git,
    });
    if (outcome.bodySource === "none") return "";
    return outcome.body.trim();
  }

  private async shouldAbsorbAfterResolve(
    agentId: string,
    run: Run,
  ): Promise<boolean> {
    if (!this.shouldAbsorbSilentRun(run)) return false;
    const text = await this.resolveWindowResultText(agentId, run);
    if (!text) return true;
    return text === formatRunBodyUnavailable();
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

      const full = await this.resolveRunSnapshot(agentId, run);
      if (await this.shouldAbsorbAfterResolve(agentId, full)) {
        this.absorbRun(agentId, run.id, thread.channel, "silent failure");
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
        await this.presenter.updateWorkStatus(target, formatWindowWorking());
      }
      return;
    }

    const agentId = thread.agent_id!;
    const full = await this.resolveRunSnapshot(agentId, run);

    if (await this.shouldAbsorbAfterResolve(agentId, full)) {
      this.absorbRun(agentId, run.id, thread.channel, "silent failure");
      this.announcedRunning.delete(run.id);
      return;
    }

    this.announcedRunning.delete(run.id);
    await this.presenter.endWork(target);

    const resultText = await this.resolveWindowResultText(agentId, full);
    const prUrls = prUrlsFromGit(full.git);

    await this.presenter.sendWindowResult(
      target,
      full.status,
      resultText,
      thread.agent_url ?? "",
      prUrls,
    );
    this.store.markRunNotified(run.id);
  }
}
