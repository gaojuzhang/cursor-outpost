import type { AppConfig } from "../config.js";
import type {
  ChannelAdapter,
  IncomingImage,
  IncomingMessage,
  OutgoingTarget,
  SendOptions,
} from "../channels/types.js";
import {
  augmentPromptWithImageNote,
  formatAgentBusyRetry,
  formatCancelNoAgent,
  formatCancelNoRun,
  formatCancelNotAllowed,
  formatCancelOk,
  formatCursorError,
  formatDoneFooter,
  formatDrainingQueue,
  formatNewSession,
  formatPollingFallback,
  formatQueued,
  formatQueueDiscarded,
  formatQueueStale,
  formatRunStatus,
  formatStreamError,
  formatThinking,
  formatToolCall,
  formatWorkStatus,
} from "../channels/telegram/format.js";
import {
  CursorApiError,
  isStreamGoneCode,
  isStreamGoneError,
  type CursorClient,
} from "../cursor/client.js";
import { isTerminalRunStatus, type Run, type StreamEvent } from "../cursor/types.js";
import type { Store } from "../store/db.js";
import { AgentQueue } from "../sync/queue.js";
import type { ActiveStreamTracker } from "../sync/active-streams.js";

const ASSISTANT_FLUSH_AT = 3500;
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 30 * 60 * 1000;
const STREAM_OPEN_ATTEMPTS = 4;
const STREAM_OPEN_DELAY_MS = 1000;
const RUN_CREATING_WAIT_MS = 20_000;

export type RouterDeps = {
  store: Store;
  cursor: CursorClient;
  channel: ChannelAdapter;
  config: AppConfig;
  streams: ActiveStreamTracker;
};

/**
 * Forward path + per-agent FIFO (step 6).
 * Poller (Window → IM) is step 7.
 */
export class Router {
  private readonly store: Store;
  private readonly cursor: CursorClient;
  private readonly channel: ChannelAdapter;
  private readonly config: AppConfig;
  private readonly streams: ActiveStreamTracker;
  private readonly queue = new AgentQueue();
  /** agentId currently draining the queue */
  private readonly pumping = new Set<string>();

  constructor(deps: RouterDeps) {
    this.store = deps.store;
    this.cursor = deps.cursor;
    this.channel = deps.channel;
    this.config = deps.config;
    this.streams = deps.streams;
  }

  private async workBegin(target: OutgoingTarget, status: string): Promise<void> {
    if (this.channel.beginWork) {
      await this.channel.beginWork(target, status);
    } else {
      await this.channel.sendStatus(target, status);
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

  private async sendOut(
    target: OutgoingTarget,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    await this.channel.sendText(target, text, opts);
  }

  async handle(msg: IncomingMessage): Promise<void> {
    const target: OutgoingTarget = {
      channel: msg.channel,
      chatId: msg.chatId,
      threadId: msg.threadId,
    };

    if (msg.command === "ping") {
      await this.channel.sendText(target, "pong");
      return;
    }

    if (msg.command === "bind") {
      await this.cmdBind(msg, target);
      return;
    }

    if (msg.command === "status") {
      await this.cmdStatus(msg, target);
      return;
    }

    if (msg.command === "new") {
      await this.cmdNew(msg, target);
      return;
    }

    if (msg.command === "cancel") {
      await this.cmdCancel(msg, target);
      return;
    }

    if (msg.command) {
      await this.channel.sendText(
        target,
        `Unknown command /${msg.command}. Try: /bind /status /new /cancel /verbose on|off /ping`,
      );
      return;
    }

    const text = msg.text.trim();
    if (!text) return;

    await this.routePrompt(msg, target, text, msg.images);
  }

  private defaultSlug(): string {
    const marked = this.config.projects.find((p) => p.default);
    if (marked) return marked.slug;
    if (this.config.projects.length === 1) return this.config.projects[0]!.slug;
    throw new Error(
      "config.yaml needs exactly one project with default: true (for private chat)",
    );
  }

  private projectSlugs(): string {
    return this.store.listProjects().map((p) => p.slug).join(", ") || "(none)";
  }

  private async cmdBind(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    if (msg.chatKind === "dm") {
      await this.channel.sendText(
        target,
        `Private chat uses the default project from config.yaml (no /bind).\nProjects: ${this.projectSlugs()}`,
      );
      return;
    }
    if (msg.chatKind !== "topic") {
      await this.channel.sendText(
        target,
        " /bind only works inside a forum topic (not General).",
      );
      return;
    }

    const slug = (msg.commandArgs ?? "").trim();
    if (!slug) {
      await this.channel.sendText(
        target,
        `Usage: /bind <slug>\nProjects: ${this.projectSlugs()}`,
      );
      return;
    }

    const project = this.store.getProject(slug);
    if (!project) {
      await this.channel.sendText(
        target,
        `Unknown slug "${slug}". Projects: ${this.projectSlugs()}`,
      );
      return;
    }

    const { previousAgentId } = this.store.bindThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
      slug,
    );
    if (previousAgentId) {
      this.queue.clear(previousAgentId);
    }

    await this.channel.sendText(
      target,
      `Bound this topic to ${slug}\n${project.repo_url}@${project.ref}` +
        (previousAgentId
          ? "\n(Previous agent mapping cleared; next message creates a new agent.)"
          : ""),
    );
  }

  private async cmdStatus(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    const thread = this.store.getActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    const verbose = this.store.resolveVerbose(
      msg.channel,
      msg.chatId,
      msg.threadId,
      this.config.telegram.verbose,
    );
    const agentId = thread?.agent_id ?? undefined;
    const streaming = agentId ? this.streams.get(agentId) : undefined;
    const queued = agentId ? this.queue.size(agentId) : 0;
    const lines = [
      `chatKind: ${msg.chatKind}`,
      `slug: ${thread?.slug ?? (msg.chatKind === "dm" ? `(default ${this.defaultSlug()})` : "(not bound — /bind <slug>)")}`,
      `agent: ${thread?.agent_id ?? "(none)"}`,
      `url: ${thread?.agent_url ?? "(none)"}`,
      `verbose: ${verbose ? "on" : "off"}`,
      `streaming_run: ${streaming ?? "(none)"}`,
      `queue: ${queued}`,
    ];
    await this.channel.sendText(target, lines.join("\n"));
  }

  private async cmdNew(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    const thread = this.store.getActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    if (thread?.agent_id) {
      const cleared = this.queue.clear(thread.agent_id);
      if (cleared > 0) {
        await this.sendOut(target, formatQueueDiscarded(cleared));
      }
    }
    this.store.resetThreadAgent(msg.channel, msg.chatId, msg.threadId);
    await this.sendOut(target, formatNewSession());
  }

  private async cmdCancel(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    const thread = this.store.getActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    if (!thread?.agent_id) {
      await this.sendOut(target, formatCancelNoAgent());
      return;
    }
    const agentId = thread.agent_id;
    const cleared = this.queue.clear(agentId);
    const runId = this.streams.get(agentId);

    if (!runId) {
      await this.sendOut(target, formatCancelNoRun(cleared));
      return;
    }

    try {
      await this.cursor.cancelRun(agentId, runId);
      await this.sendOut(target, formatCancelOk(runId, cleared));
    } catch (err) {
      if (err instanceof CursorApiError && err.status === 409) {
        await this.sendOut(target, formatCancelNotAllowed(cleared));
        return;
      }
      throw err;
    }
  }

  private async routePrompt(
    msg: IncomingMessage,
    target: OutgoingTarget,
    text: string,
    images?: IncomingImage[],
  ): Promise<void> {
    let slug: string;
    if (msg.chatKind === "dm") {
      slug = this.defaultSlug();
    } else if (msg.chatKind === "topic") {
      const existing = this.store.getActiveThread(
        msg.channel,
        msg.chatId,
        msg.threadId,
      );
      if (!existing?.slug) {
        await this.channel.sendText(
          target,
          `This topic is not bound. Use /bind <slug>\nProjects: ${this.projectSlugs()}`,
        );
        return;
      }
      slug = existing.slug;
    } else {
      return;
    }

    const project = this.store.getProject(slug);
    if (!project) {
      await this.channel.sendText(
        target,
        `Project ${slug} is missing from the DB. Check config.yaml and restart.`,
      );
      return;
    }

    const thread = this.store.ensureActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
      slug,
    );

    // First message on thread: create agent (no queue key yet).
    if (!thread.agent_id) {
      const created = await this.startCreate(msg, target, text, project, images);
      if (!created) return;
      await this.drainQueue(created.agentId);
      return;
    }

    const agentId = thread.agent_id;

    // Busy: enqueue instead of 409 to user.
    if (this.streams.get(agentId) || this.pumping.has(agentId)) {
      const n = this.queue.enqueue(agentId, {
        text,
        target,
        channel: msg.channel,
        images,
      });
      await this.sendOut(target, formatQueued(n));
      return;
    }

    this.pumping.add(agentId);
    try {
      await this.startFollowUp(
        msg,
        target,
        text,
        agentId,
        thread.agent_url,
        images,
      );
      await this.drainQueueLocked(agentId);
    } finally {
      this.pumping.delete(agentId);
    }
  }

  /** After create/stream finished; drain any prompts queued during the run. */
  private async drainQueue(agentId: string): Promise<void> {
    if (this.pumping.has(agentId)) return;
    this.pumping.add(agentId);
    try {
      await this.drainQueueLocked(agentId);
    } finally {
      this.pumping.delete(agentId);
    }
  }

  /** Caller must hold `pumping` for agentId. */
  private async drainQueueLocked(agentId: string): Promise<void> {
    while (true) {
      const item = this.queue.dequeue(agentId);
      if (!item) break;
      await this.workUpdate(
        item.target,
        formatDrainingQueue(this.queue.size(agentId)),
      );
      const thread = this.store.getActiveThread(
        item.target.channel,
        item.target.chatId,
        item.target.threadId,
      );
      if (!thread?.agent_id || thread.agent_id !== agentId) {
        await this.sendOut(item.target, formatQueueStale());
        this.queue.clear(agentId);
        break;
      }
      await this.startFollowUp(
        {
          channel: item.channel,
          chatId: item.target.chatId,
          threadId: item.target.threadId,
        },
        item.target,
        item.text,
        agentId,
        thread.agent_url,
        item.images,
      );
    }
  }

  private async startCreate(
    msg: IncomingMessage,
    target: OutgoingTarget,
    text: string,
    project: { repo_url: string; ref: string },
    images?: IncomingImage[],
  ): Promise<{ agentId: string } | undefined> {
    let agentId: string;
    let agentUrl: string;
    let runId: string;
    try {
      await this.workBegin(target, formatWorkStatus("Creating agent"));
      const promptText = augmentPromptWithImageNote(text, images);
      if (images?.length) {
        console.log(
          `outpost: image prompt footnote applied (${promptText.slice(0, 80).replace(/\n/g, " ")}…)`,
        );
      }
      const created = await this.cursor.createAgent({
        text: promptText,
        repoUrl: project.repo_url,
        startingRef: project.ref,
        images,
      });
      agentId = created.agent.id;
      agentUrl = created.agent.url;
      runId = created.run.id;
      // Claim busy before exposing mapping so concurrent msgs enqueue.
      this.streams.set(agentId, runId);
      this.store.setThreadAgent(
        msg.channel,
        msg.chatId,
        msg.threadId,
        agentId,
        agentUrl,
      );
    } catch (err) {
      await this.workEnd(target);
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, formatCursorError(message));
      return undefined;
    }

    this.store.insertRun({
      runId,
      agentId,
      origin: "telegram",
      channel: msg.channel,
    });
    this.store.addOutboundPrompt(
      agentId,
      augmentPromptWithImageNote(text, images),
    );

    await this.streamToChannel({
      target,
      agentId,
      agentUrl,
      runId,
      verbose: this.store.resolveVerbose(
        msg.channel,
        msg.chatId,
        msg.threadId,
        this.config.telegram.verbose,
      ),
    });
    return { agentId };
  }

  private async startFollowUp(
    msg: Pick<IncomingMessage, "channel" | "chatId" | "threadId">,
    target: OutgoingTarget,
    text: string,
    agentId: string,
    agentUrl: string | null,
    images?: IncomingImage[],
  ): Promise<void> {
    let runId: string;
    let url = agentUrl;
    try {
      await this.workBegin(target, formatWorkStatus("Sending follow-up"));
      const promptText = augmentPromptWithImageNote(text, images);
      if (images?.length) {
        console.log(
          `outpost: image prompt footnote applied (${promptText.slice(0, 80).replace(/\n/g, " ")}…)`,
        );
      }
      let created;
      try {
        created = await this.cursor.createRun(agentId, promptText, images);
      } catch (err) {
        if (err instanceof CursorApiError && err.status === 409) {
          await this.workUpdate(target, formatAgentBusyRetry());
          await this.waitUntilAgentIdle(agentId);
          created = await this.cursor.createRun(agentId, promptText, images);
        } else {
          throw err;
        }
      }
      runId = created.run.id;
      this.streams.set(agentId, runId);
      if (!url) {
        url = (await this.cursor.getAgent(agentId)).url;
        this.store.setThreadAgent(
          msg.channel,
          msg.chatId,
          msg.threadId,
          agentId,
          url,
        );
      }
    } catch (err) {
      await this.workEnd(target);
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, formatCursorError(message));
      return;
    }

    this.store.insertRun({
      runId,
      agentId,
      origin: "telegram",
      channel: msg.channel,
    });
    this.store.addOutboundPrompt(
      agentId,
      augmentPromptWithImageNote(text, images),
    );

    await this.streamToChannel({
      target,
      agentId,
      agentUrl: url ?? "",
      runId,
      verbose: this.store.resolveVerbose(
        msg.channel,
        msg.chatId,
        msg.threadId,
        this.config.telegram.verbose,
      ),
    });
  }

  private async streamToChannel(opts: {
    target: OutgoingTarget;
    agentId: string;
    agentUrl: string;
    runId: string;
    verbose: boolean;
  }): Promise<void> {
    const { target, agentId, agentUrl, runId, verbose } = opts;
    this.streams.set(agentId, runId);

    let assistantBuf = "";
    let thinkingBuf = "";
    let lastStatus: string | undefined;
    let assistantSent = false;
    let terminalText: string | undefined;
    let terminalGit: Run["git"] | undefined;
    let sawResult = false;

    const flushAssistant = async (force = false): Promise<void> => {
      while (
        assistantBuf.length >= ASSISTANT_FLUSH_AT ||
        (force && assistantBuf.length > 0)
      ) {
        const take = Math.min(assistantBuf.length, ASSISTANT_FLUSH_AT);
        const piece = assistantBuf.slice(0, take);
        assistantBuf = assistantBuf.slice(take);
        await this.sendOut(target, piece);
        assistantSent = true;
      }
    };

    const flushThinking = async (force = false): Promise<void> => {
      if (!verbose) {
        thinkingBuf = "";
        return;
      }
      while (
        thinkingBuf.length >= ASSISTANT_FLUSH_AT ||
        (force && thinkingBuf.trim().length > 0)
      ) {
        const take = Math.min(thinkingBuf.length, ASSISTANT_FLUSH_AT);
        const piece = thinkingBuf.slice(0, take);
        thinkingBuf = thinkingBuf.slice(take);
        const line = formatThinking(piece, { verbose: true });
        if (line) await this.sendOut(target, line, { silent: true });
      }
    };

    const handleEvent = async (ev: StreamEvent): Promise<void> => {
      switch (ev.type) {
        case "status":
          if (ev.data.status !== lastStatus) {
            lastStatus = ev.data.status;
            await this.workUpdate(target, formatRunStatus(ev.data.status));
          }
          break;
        case "assistant":
          await flushThinking(true);
          assistantBuf += ev.data.text;
          await flushAssistant(false);
          break;
        case "thinking":
          thinkingBuf += ev.data.text;
          await flushThinking(false);
          break;
        case "tool_call": {
          await flushThinking(true);
          const line = formatToolCall(ev.data.name, ev.data.status, {
            verbose,
          });
          if (line) await this.sendOut(target, line, { silent: true });
          break;
        }
        case "result":
          sawResult = true;
          terminalText = ev.data.text;
          terminalGit = ev.data.git;
          break;
        case "error":
          // Mid-stream "gone" — same as HTTP 409/410: fall back to getRun.
          if (isStreamGoneCode(ev.data.code)) {
            throw new CursorApiError(
              409,
              ev.data.message,
              ev.data.code,
            );
          }
          await this.sendOut(
            target,
            formatStreamError(ev.data.code, ev.data.message),
          );
          break;
        default:
          break;
      }
    };

    try {
      let streamEventCount = 0;
      const preflight = await this.waitForRunActive(agentId, runId);

      if (isTerminalRunStatus(preflight.status)) {
        console.log(
          `outpost: run already ${preflight.status} before stream attach, using getRun`,
        );
        terminalText = preflight.result;
        terminalGit = preflight.git;
        sawResult = true;
      } else {
        let streamDone = false;
        for (let attempt = 0; attempt < STREAM_OPEN_ATTEMPTS; attempt++) {
          try {
            for await (const ev of this.cursor.streamRun(agentId, runId)) {
              streamEventCount++;
              await handleEvent(ev);
            }
            streamDone = true;
            break;
          } catch (err) {
            if (!isStreamGoneError(err)) throw err;

            const snap = await this.cursor.getRun(agentId, runId);
            if (isTerminalRunStatus(snap.status)) {
              console.log(
                `outpost: stream unavailable (${err.status} ${err.code ?? ""}) ` +
                  `after ${streamEventCount} events, run=${snap.status} — using getRun`,
              );
              terminalText = snap.result;
              terminalGit = snap.git;
              sawResult = true;
              streamDone = true;
              break;
            }

            if (attempt + 1 < STREAM_OPEN_ATTEMPTS) {
              console.log(
                `outpost: stream unavailable (${err.status} ${err.code ?? ""}) ` +
                  `attempt ${attempt + 1}/${STREAM_OPEN_ATTEMPTS}, ` +
                  `events=${streamEventCount}, run=${snap.status} — retrying…`,
              );
              await this.workUpdate(target, formatPollingFallback());
              await new Promise((r) =>
                setTimeout(r, STREAM_OPEN_DELAY_MS * (attempt + 1)),
              );
              continue;
            }

            console.log(
              `outpost: stream unavailable (${err.status} ${err.code ?? ""}) ` +
                `after ${streamEventCount} events, run=${snap.status} — polling getRun…`,
            );
            await this.workUpdate(target, formatPollingFallback());
            const run = await this.waitForRunTerminal(agentId, runId);
            terminalText = run.result;
            terminalGit = run.git;
            sawResult = isTerminalRunStatus(run.status);
            streamDone = true;
            break;
          }
        }
        if (!streamDone) {
          const run = await this.waitForRunTerminal(agentId, runId);
          terminalText = run.result;
          terminalGit = run.git;
          sawResult = isTerminalRunStatus(run.status);
        }
      }

      await flushThinking(true);
      await flushAssistant(true);

      if (!sawResult) {
        const run = await this.waitForRunTerminal(agentId, runId);
        terminalText = run.result ?? terminalText;
        terminalGit = run.git ?? terminalGit;
      }

      const prUrls =
        terminalGit?.branches
          ?.map((b) => b.prUrl)
          .filter((u): u is string => Boolean(u)) ?? [];

      await this.workEnd(target);

      if (!assistantSent && terminalText?.trim()) {
        await this.sendOut(target, terminalText.trim());
      }

      await this.sendOut(
        target,
        formatDoneFooter(agentUrl, prUrls, assistantSent),
      );
    } catch (err) {
      await this.workEnd(target);
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, `❌ Stream failed: ${message}`);
    } finally {
      this.streams.clear(agentId, runId);
    }
  }

  /** Wait until run leaves CREATING (stream may 409 if opened too early). */
  private async waitForRunActive(agentId: string, runId: string): Promise<Run> {
    const started = Date.now();
    let last = await this.cursor.getRun(agentId, runId);
    while (
      last.status === "CREATING" &&
      Date.now() - started < RUN_CREATING_WAIT_MS
    ) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      last = await this.cursor.getRun(agentId, runId);
    }
    return last;
  }

  /** Poll getRun until terminal or timeout (used when SSE is gone). */
  private async waitForRunTerminal(agentId: string, runId: string): Promise<Run> {
    const started = Date.now();
    let last: Run | undefined;
    while (Date.now() - started < POLL_MAX_MS) {
      last = await this.cursor.getRun(agentId, runId);
      if (isTerminalRunStatus(last.status)) return last;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (last) return last;
    return this.cursor.getRun(agentId, runId);
  }

  /** Wait until latest run is terminal (or none active). */
  private async waitUntilAgentIdle(agentId: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < POLL_MAX_MS) {
      const listed = await this.cursor.listRuns(agentId, { limit: 1 });
      const latest = listed.items[0];
      if (!latest || isTerminalRunStatus(latest.status)) return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}
