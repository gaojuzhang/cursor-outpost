import {
  assistantFollowingLastUserMessage,
  assistantFollowingPromptText,
  lastAssistantText,
} from "../core/conversation-text.js";
import type { ObservedTokenUsage } from "../core/context-observe.js";
import type { CursorClient } from "../cursor/client.js";
import { formatRunBodyUnavailable } from "../channels/telegram/format.js";
import type { Run } from "../cursor/types.js";
import type { RunBodySource, RunOutcome } from "./run-outcome.js";

const RESOLVE_DEADLINE_MS = 20_000;
const RESOLVE_POLL_MS = 2500;
const TERMINAL_MIN_WAIT_MS = 3000;

export type RunBodyResolverDeps = {
  cursor: CursorClient;
  getOutboundPromptText: (agentId: string, runId: string) => string | undefined;
};

export type ResolveRunBodyInput = {
  agentId: string;
  runId: string;
  streamBuffer: string;
  gitHint?: Run["git"];
  usageHint?: ObservedTokenUsage;
};

export class RunBodyResolver {
  private readonly cursor: CursorClient;
  private readonly getOutboundPromptText: (
    agentId: string,
    runId: string,
  ) => string | undefined;

  constructor(deps: RunBodyResolverDeps) {
    this.cursor = deps.cursor;
    this.getOutboundPromptText = deps.getOutboundPromptText;
  }

  async resolve(input: ResolveRunBodyInput): Promise<RunOutcome> {
    const streamBody = input.streamBuffer.trim();
    if (streamBody) {
      return this.outcome(streamBody, "stream", input.gitHint, input.usageHint);
    }

    const started = Date.now();
    const deadline = started + RESOLVE_DEADLINE_MS;
    let lastGit = input.gitHint;
    let lastUsage = input.usageHint;

    while (Date.now() < deadline) {
      const snap = await this.cursor.snapshotRun(input.agentId, input.runId, {
        waitIfRunning: Date.now() - started < 5000,
        waitMaxMs: 5000,
      });
      lastGit = snap.git ?? lastGit;
      lastUsage = snap.usage ?? lastUsage;

      if (snap.result?.trim()) {
        console.log(
          `outpost: run body from run.result agent=${input.agentId} run=${input.runId}`,
        );
        return this.outcome(snap.result.trim(), "run", lastGit, lastUsage);
      }

      const runConv = await this.cursor.getRunConversationText(
        input.agentId,
        input.runId,
      );
      if (runConv) {
        console.log(
          `outpost: run body from run.conversation agent=${input.agentId} run=${input.runId}`,
        );
        return this.outcome(runConv, "run_conversation", lastGit, lastUsage);
      }

      const v0 = await this.resolveV0Conversation(input.agentId, input.runId);
      if (v0) {
        return this.outcome(v0.text, "conversation", lastGit, lastUsage);
      }

      if (
        snap.isTerminal &&
        Date.now() - started >= TERMINAL_MIN_WAIT_MS
      ) {
        break;
      }

      await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
    }

    const snap = await this.cursor.snapshotRun(input.agentId, input.runId, {
      waitIfRunning: true,
      waitMaxMs: 15_000,
    });
    if (snap.result?.trim()) {
      return this.outcome(snap.result.trim(), "run", snap.git ?? lastGit, snap.usage ?? lastUsage);
    }

    const runConv = await this.cursor.getRunConversationText(
      input.agentId,
      input.runId,
    );
    if (runConv) {
      return this.outcome(runConv, "run_conversation", snap.git ?? lastGit, snap.usage ?? lastUsage);
    }

    const v0 = await this.resolveV0Conversation(input.agentId, input.runId);
    if (v0) {
      return this.outcome(v0.text, "conversation", snap.git ?? lastGit, snap.usage ?? lastUsage);
    }

    console.warn(
      `outpost: run body unresolved agent=${input.agentId} run=${input.runId} status=${snap.status}`,
    );
    return this.outcome(
      formatRunBodyUnavailable(),
      "none",
      snap.git ?? lastGit,
      snap.usage ?? lastUsage,
    );
  }

  private outcome(
    body: string,
    bodySource: RunBodySource,
    git?: Run["git"],
    usage?: ObservedTokenUsage,
  ): RunOutcome {
    return { body, bodySource, git, usage };
  }

  private async resolveV0Conversation(
    agentId: string,
    runId: string,
  ): Promise<{ text: string; matched: boolean } | undefined> {
    try {
      const conv = await this.cursor.getConversation(agentId);
      const promptText = this.getOutboundPromptText(agentId, runId);
      const matched = promptText
        ? assistantFollowingPromptText(conv, promptText)
        : undefined;
      const afterLastUser = assistantFollowingLastUserMessage(conv);
      const text = matched ?? afterLastUser ?? lastAssistantText(conv);
      if (!text) return undefined;
      console.log(
        `outpost: run body from v0 conversation agent=${agentId} run=${runId} ` +
          `matched=${Boolean(matched)} lastUser=${Boolean(afterLastUser && !matched)}`,
      );
      return { text, matched: Boolean(matched) };
    } catch {
      return undefined;
    }
  }
}
