import type { ObservedTokenUsage } from "../core/context-observe.js";
import {
  isCompactionHint,
  normalizeObservedUsage,
} from "../core/context-observe.js";
import {
  CursorApiError,
  isStreamGoneCode,
  isStreamGoneError,
  type CursorClient,
} from "../cursor/client.js";
import type { StreamEvent } from "../cursor/types.js";
import { isTerminalRunStatus } from "../cursor/types.js";
import {
  formatPollingFallback,
  formatRunStatus,
  formatStreamError,
  formatThinking,
  formatToolCall,
} from "../channels/telegram/format.js";
import type { OutgoingTarget } from "../channels/types.js";
import type { ActiveStreamTracker } from "../sync/active-streams.js";
import type { RunBodyResolver } from "./run-body-resolver.js";
import { prUrlsFromGit, type RunOutcome } from "./run-outcome.js";
import type { TelegramRunPresenter } from "./telegram-presenter.js";

const ASSISTANT_FLUSH_AT = 3500;
const STREAM_OPEN_ATTEMPTS = 4;
const STREAM_OPEN_DELAY_MS = 1000;

export type RunSessionHooks = {
  onUsage?: (
    target: OutgoingTarget,
    usage: ObservedTokenUsage,
  ) => Promise<void>;
  onSummarizing?: (target: OutgoingTarget) => Promise<void>;
  onSummarized?: (target: OutgoingTarget) => Promise<void>;
};

export type RunSessionOpts = {
  target: OutgoingTarget;
  agentId: string;
  agentUrl: string;
  runId: string;
  verbose: boolean;
};

export type RunSessionDeps = {
  cursor: CursorClient;
  resolver: RunBodyResolver;
  presenter: TelegramRunPresenter;
  streams: ActiveStreamTracker;
  hooks?: RunSessionHooks;
};

/**
 * One cloud run: optional stream observation → RunBodyResolver → Telegram finalize.
 */
export class RunSession {
  private readonly cursor: CursorClient;
  private readonly resolver: RunBodyResolver;
  private readonly presenter: TelegramRunPresenter;
  private readonly streams: ActiveStreamTracker;
  private readonly hooks?: RunSessionHooks;

  constructor(deps: RunSessionDeps) {
    this.cursor = deps.cursor;
    this.resolver = deps.resolver;
    this.presenter = deps.presenter;
    this.streams = deps.streams;
    this.hooks = deps.hooks;
  }

  async deliver(opts: RunSessionOpts): Promise<RunOutcome> {
    const { target, agentId, agentUrl, runId, verbose } = opts;
    this.streams.set(agentId, runId);

    let assistantBuf = "";
    let thinkingBuf = "";
    let bodyStreamed = false;
    let gitHint: RunOutcome["git"] | undefined;
    let usageHint: ObservedTokenUsage | undefined;
    let summarizingNotified = false;

    const flushAssistant = async (force = false): Promise<void> => {
      while (
        assistantBuf.length >= ASSISTANT_FLUSH_AT ||
        (force && assistantBuf.length > 0)
      ) {
        const take = Math.min(assistantBuf.length, ASSISTANT_FLUSH_AT);
        const piece = assistantBuf.slice(0, take);
        assistantBuf = assistantBuf.slice(take);
        await this.presenter.appendBody(target, piece);
        bodyStreamed = true;
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
        if (line) {
          await this.presenter.sendSideChannel(target, line, { silent: true });
        }
      }
    };

    const notifySummarizing = async (): Promise<void> => {
      if (summarizingNotified) return;
      summarizingNotified = true;
      if (this.hooks?.onSummarizing) await this.hooks.onSummarizing(target);
    };

    const handleUsage = async (
      usage: ObservedTokenUsage | undefined,
    ): Promise<void> => {
      const normalized = normalizeObservedUsage(usage);
      if (!normalized) return;
      usageHint = normalized;
      if (this.hooks?.onUsage) await this.hooks.onUsage(target, normalized);
    };

    const handleEvent = async (ev: StreamEvent): Promise<void> => {
      switch (ev.type) {
        case "status":
          await this.presenter.updateWorkStatus(
            target,
            formatRunStatus(ev.data.status),
          );
          if (isCompactionHint(ev.data.message)) await notifySummarizing();
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
          if (line) {
            await this.presenter.sendSideChannel(target, line, { silent: true });
          }
          break;
        }
        case "result":
          gitHint = ev.data.git ?? gitHint;
          if (ev.data.text?.trim()) {
            assistantBuf += ev.data.text;
            await flushAssistant(true);
          }
          await handleUsage(ev.data.usage);
          break;
        case "usage":
          await handleUsage(ev.data.usage);
          break;
        case "summary":
          if (ev.data.phase === "started") await notifySummarizing();
          else if (this.hooks?.onSummarized) {
            await this.hooks.onSummarized(target);
          }
          break;
        case "error":
          if (isStreamGoneCode(ev.data.code)) {
            throw new CursorApiError(409, ev.data.message, ev.data.code);
          }
          await this.presenter.sendSideChannel(
            target,
            formatStreamError(ev.data.code, ev.data.message),
          );
          break;
        default:
          break;
      }
    };

    try {
      await this.presenter.beginWork(target);

      const preflight = await this.cursor.waitForRunActive(agentId, runId);
      const skipStream = isTerminalRunStatus(preflight.status);

      if (skipStream) {
        console.log(
          `outpost: run already ${preflight.status} before stream — resolve-only path`,
        );
        gitHint = preflight.git ?? gitHint;
      } else {
        let streamDone = false;
        for (let attempt = 0; attempt < STREAM_OPEN_ATTEMPTS; attempt++) {
          try {
            for await (const ev of this.cursor.streamRun(agentId, runId)) {
              await handleEvent(ev);
            }
            streamDone = true;
            break;
          } catch (err) {
            if (!isStreamGoneError(err)) throw err;

            const snap = await this.cursor.snapshotRun(agentId, runId);
            if (snap.isTerminal) {
              console.log(
                `outpost: stream unavailable (${err.status}) run terminal — resolve path`,
              );
              gitHint = snap.git ?? gitHint;
              if (snap.result?.trim()) {
                assistantBuf += snap.result;
                await flushAssistant(true);
              }
              streamDone = true;
              break;
            }

            if (attempt + 1 < STREAM_OPEN_ATTEMPTS) {
              await this.presenter.updateWorkStatus(
                target,
                formatPollingFallback(),
              );
              await new Promise((r) =>
                setTimeout(r, STREAM_OPEN_DELAY_MS * (attempt + 1)),
              );
              continue;
            }

            await this.presenter.updateWorkStatus(
              target,
              formatPollingFallback(),
            );
            const terminal = await this.cursor.snapshotRun(agentId, runId, {
              waitIfRunning: true,
              waitMaxMs: 15_000,
            });
            gitHint = terminal.git ?? gitHint;
            if (terminal.result?.trim()) {
              assistantBuf += terminal.result;
              await flushAssistant(true);
            }
            streamDone = true;
            break;
          }
        }
        if (!streamDone) {
          const terminal = await this.cursor.snapshotRun(agentId, runId, {
            waitIfRunning: true,
            waitMaxMs: 15_000,
          });
          gitHint = terminal.git ?? gitHint;
          if (terminal.result?.trim()) {
            assistantBuf += terminal.result;
            await flushAssistant(true);
          }
        }
      }

      await flushThinking(true);
      await flushAssistant(true);

      const outcome = await this.resolver.resolve({
        agentId,
        runId,
        streamBuffer: assistantBuf,
        gitHint,
        usageHint,
      });

      if (!usageHint && outcome.usage) {
        await handleUsage(outcome.usage);
      }

      const prUrls = prUrlsFromGit(outcome.git ?? gitHint);
      await this.presenter.finalize(
        target,
        outcome.body,
        agentUrl,
        prUrls,
        bodyStreamed,
      );

      console.log(
        `outpost: run delivered agent=${agentId} run=${runId} source=${outcome.bodySource} streamed=${bodyStreamed}`,
      );

      return outcome;
    } catch (err) {
      await this.presenter.endWork(target);
      throw err;
    } finally {
      this.streams.clear(agentId, runId);
    }
  }
}
