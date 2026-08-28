import { isGenericAgentName } from "./agent-label.js";
import { logModel } from "./model-log.js";
import { AUTO_MODEL_ID, isAutoModelId } from "./model-prefs.js";
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
  formatBindAlreadyBound,
  formatBindConfirmRequired,
  formatBindCurrentBinding,
  formatBindOk,
  formatBindUsage,
  formatCancelNoAgent,
  formatCancelNoRun,
  formatCancelNotAllowed,
  formatCancelOk,
  formatContextNearlyFull,
  formatContextSummarized,
  formatContextSummarizing,
  formatContextUsageNote,
  formatCursorError,
  formatDrainingQueue,
  formatModelListEntry,
  formatModelListFooter,
  formatModelListHeader,
  formatModelNotFound,
  formatModelSet,
  formatNewSession,
  formatQueued,
  formatQueueDiscarded,
  formatQueueStale,
  formatRepoListEmpty,
  formatRepoListEntryHtml,
  formatRepoListFooter,
  formatRepoListHeader,
  formatSessionCacheFresh,
  formatSessionListFooterHtml,
  formatSessionListHeader,
  formatSessionListHeaderHtml,
  formatSessionListTableHtmlChunks,
  formatSessionNotFound,
  formatSessionRefreshOk,
  formatSessionResumed,
  formatWorkStatus,
  TELEGRAM_TEXT_LIMIT,
} from "../channels/telegram/format.js";
import { CursorApiError, type CursorClient } from "../cursor/client.js";
import { isTerminalRunStatus } from "../cursor/types.js";
import type { CachedAgentRow, Store, ThreadBinding } from "../store/db.js";
import { repoUrlMatches } from "./repo-url.js";
import { AgentCatalog } from "../sync/agent-catalog.js";
import { ModelCatalog } from "../sync/model-catalog.js";
import { RepoCatalog } from "../sync/repo-catalog.js";
import { AgentQueue } from "../sync/queue.js";
import type { ActiveStreamTracker } from "../sync/active-streams.js";
import {
  contextUsagePct,
  estimateContextTokens,
  normalizeObservedUsage,
  type ObservedTokenUsage,
  shouldWarnNearFull,
} from "./context-observe.js";
import { RunBodyResolver } from "../delivery/run-body-resolver.js";
import { RunSession } from "../delivery/run-session.js";
import { TelegramRunPresenter } from "../delivery/telegram-presenter.js";

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 30 * 60 * 1000;

export type RouterDeps = {
  store: Store;
  cursor: CursorClient;
  channel: ChannelAdapter;
  config: AppConfig;
  streams: ActiveStreamTracker;
  catalog: AgentCatalog;
  models: ModelCatalog;
  repos: RepoCatalog;
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
  private readonly catalog: AgentCatalog;
  private readonly models: ModelCatalog;
  private readonly repos: RepoCatalog;
  private readonly runBodyResolver: RunBodyResolver;
  private readonly queue = new AgentQueue();
  /** agentId currently draining the queue */
  private readonly pumping = new Set<string>();

  constructor(deps: RouterDeps) {
    this.store = deps.store;
    this.cursor = deps.cursor;
    this.channel = deps.channel;
    this.config = deps.config;
    this.streams = deps.streams;
    this.catalog = deps.catalog;
    this.models = deps.models;
    this.repos = deps.repos;
    this.runBodyResolver = new RunBodyResolver({
      cursor: this.cursor,
      getOutboundPromptText: (agentId, runId) =>
        this.store.getOutboundPromptText(agentId, runId),
    });
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

  private verboseFor(
    msg: Pick<IncomingMessage, "channel" | "chatId" | "threadId">,
  ): boolean {
    return this.store.resolveVerbose(
      msg.channel,
      msg.chatId,
      msg.threadId,
      this.config.telegram.verbose,
    );
  }

  private async observeContextFromUsage(
    target: OutgoingTarget,
    usage: ObservedTokenUsage | undefined,
    state: { nearFullWarned: boolean },
    verbose: boolean,
  ): Promise<void> {
    const normalized = normalizeObservedUsage(usage);
    if (!normalized) return;
    const tokens = estimateContextTokens(normalized);
    const pct = contextUsagePct(tokens);
    if (verbose && pct >= 50) {
      await this.sendOut(target, formatContextUsageNote(pct, tokens), {
        silent: true,
      });
    }
    if (shouldWarnNearFull(tokens) && !state.nearFullWarned) {
      state.nearFullWarned = true;
      await this.sendOut(target, formatContextNearlyFull(pct, tokens));
    }
  }

  private async notifyContextSummarizing(
    target: OutgoingTarget,
    state: { summarizingNotified: boolean },
  ): Promise<void> {
    if (state.summarizingNotified) return;
    state.summarizingNotified = true;
    await this.sendOut(target, formatContextSummarizing());
  }

  private async notifyContextSummarized(target: OutgoingTarget): Promise<void> {
    await this.sendOut(target, formatContextSummarized());
  }

  private async observeRunContextUsage(
    target: OutgoingTarget,
    agentId: string,
    runId: string,
    state: { nearFullWarned: boolean },
    verbose: boolean,
  ): Promise<void> {
    try {
      const usage = await this.cursor.getRunTokenUsage(agentId, runId);
      await this.observeContextFromUsage(target, usage, state, verbose);
    } catch {
      /* run gone or usage unavailable */
    }
  }

  private async deliverRun(opts: {
    target: OutgoingTarget;
    agentId: string;
    agentUrl: string;
    runId: string;
    verbose: boolean;
  }): Promise<void> {
    const { target, agentId, agentUrl, runId, verbose } = opts;
    const contextState = { nearFullWarned: false };
    const summaryState = { summarizingNotified: false };

    const session = new RunSession({
      cursor: this.cursor,
      resolver: this.runBodyResolver,
      presenter: new TelegramRunPresenter(this.channel),
      streams: this.streams,
      hooks: {
        onUsage: (t, u) =>
          this.observeContextFromUsage(t, u, contextState, verbose),
        onSummarizing: (t) => this.notifyContextSummarizing(t, summaryState),
        onSummarized: (t) => this.notifyContextSummarized(t),
      },
    });

    try {
      const outcome = await session.deliver({
        target,
        agentId,
        agentUrl,
        runId,
        verbose,
      });
      if (!outcome.usage) {
        await this.observeRunContextUsage(
          target,
          agentId,
          runId,
          contextState,
          verbose,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, `❌ Stream failed: ${message}`);
    }
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

    if (msg.command === "resume" || msg.command === "sessions") {
      await this.cmdResume(msg, target);
      return;
    }

    if (msg.command === "cancel") {
      await this.cmdCancel(msg, target);
      return;
    }

    if (msg.command === "model") {
      await this.cmdModel(msg, target);
      return;
    }

    if (msg.command === "repos") {
      await this.cmdRepos(msg, target);
      return;
    }

    if (msg.command) {
      await this.channel.sendText(
        target,
        `Unknown command /${msg.command}. Try: /bind /repos /status /new /resume /model /cancel /verbose on|off /ping`,
      );
      return;
    }

    const text = msg.text.trim();
    if (!text) return;

    await this.routePrompt(msg, target, text, msg.images);
  }

  private defaultProject(): {
    slug: string;
    repo_url: string;
    ref: string;
  } {
    const marked = this.config.projects.find((p) => p.default);
    if (marked) return marked;
    if (this.config.projects.length === 1) {
      return this.config.projects[0]!;
    }
    throw new Error(
      "config.yaml needs a default project for private chat (default: true on one entry)",
    );
  }

  private defaultSlug(): string {
    return this.defaultProject().slug;
  }

  private parseBindArgs(raw: string): {
    token: string;
    confirmed: boolean;
    missingTokenAfterConfirm?: boolean;
  } {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { token: "", confirmed: false };
    }
    const last = tokens[tokens.length - 1]!.toLowerCase();
    const confirmed = last === "confirm" || last === "确认";
    const token = confirmed ? tokens.slice(0, -1).join(" ").trim() : raw.trim();
    return {
      token,
      confirmed,
      missingTokenAfterConfirm: confirmed && !token,
    };
  }

  private async cmdBind(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    if (msg.chatKind === "dm") {
      const dm = this.defaultProject();
      await this.channel.sendText(
        target,
        `私聊使用 config 默认仓库（无需 /bind）\n${dm.slug} → ${dm.repo_url}@${dm.ref}`,
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

    const thread = this.store.getActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    const currentBinding = this.store.resolveThreadBinding(thread);
    const rawArgs = (msg.commandArgs ?? "").trim();

    if (!rawArgs) {
      if (currentBinding) {
        await this.channel.sendText(
          target,
          formatBindCurrentBinding({
            slug: currentBinding.slug,
            repoUrl: currentBinding.repo_url,
            ref: currentBinding.ref,
            agentId: thread?.agent_id,
          }),
        );
        return;
      }
      await this.channel.sendText(target, formatBindUsage());
      return;
    }

    const parsed = this.parseBindArgs(rawArgs);
    if (parsed.missingTokenAfterConfirm) {
      await this.channel.sendText(
        target,
        "用法：/bind <序号|仓库名> confirm\n先 /repos 查看列表",
      );
      return;
    }

    let repoList: Awaited<ReturnType<RepoCatalog["list"]>>;
    try {
      repoList = await this.repos.list(false);
      this.repos.syncToStore(this.store, repoList);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, formatCursorError(message));
      return;
    }

    const picked = this.repos.resolveToken(parsed.token, repoList);
    if (!picked) {
      await this.channel.sendText(
        target,
        `未找到「${parsed.token}」。先 /repos 查看序号或仓库名。`,
      );
      return;
    }

    const newBinding: ThreadBinding = {
      slug: this.repos.slug(picked.url),
      repo_url: picked.url,
      ref: "main",
    };
    this.store.upsertCursorRepos([
      { slug: newBinding.slug, repoUrl: newBinding.repo_url, ref: newBinding.ref },
    ]);

    if (
      currentBinding &&
      repoUrlMatches(currentBinding.repo_url, newBinding.repo_url)
    ) {
      await this.channel.sendText(
        target,
        formatBindAlreadyBound({
          slug: newBinding.slug,
          repoUrl: newBinding.repo_url,
          ref: newBinding.ref,
          agentId: thread?.agent_id,
        }),
      );
      return;
    }

    if (currentBinding && !parsed.confirmed) {
      await this.channel.sendText(
        target,
        formatBindConfirmRequired({
          currentSlug: currentBinding.slug,
          currentRepo: currentBinding.repo_url,
          currentRef: currentBinding.ref,
          currentAgentId: thread?.agent_id,
          newSlug: newBinding.slug,
          newRepo: newBinding.repo_url,
          newRef: newBinding.ref,
        }),
      );
      return;
    }

    const { previousAgentId } = this.store.bindThreadRepo(
      msg.channel,
      msg.chatId,
      msg.threadId,
      newBinding,
    );
    if (previousAgentId) {
      this.queue.clear(previousAgentId);
      this.streams.clearAgent(previousAgentId);
      this.cursor.clearAgentCache(previousAgentId);
      this.store.clearAgentSyncState(previousAgentId);
    }

    await this.channel.sendText(
      target,
      formatBindOk({
        slug: newBinding.slug,
        repoUrl: newBinding.repo_url,
        ref: newBinding.ref,
        clearedAgent: Boolean(previousAgentId),
      }),
    );
  }

  private async cmdRepos(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    const args = (msg.commandArgs ?? "").trim();
    const forceRefresh =
      args.toLowerCase() === "refresh" ||
      args === "刷新" ||
      args.toLowerCase() === "reload";

    if (!forceRefresh) {
      const last = this.repos.lastLoadedAt();
      const interval = this.config.repo_catalog.interval_ms;
      if (last != null && Date.now() - last < interval) {
        await this.sendRepoList(target, false, true);
        return;
      }
    }

    try {
      await this.repos.list(forceRefresh);
      this.repos.syncToStore(this.store);
      await this.sendRepoList(target, forceRefresh, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, formatCursorError(message));
    }
  }

  private async sendRepoList(
    target: OutgoingTarget,
    forced: boolean,
    fromCacheOnly: boolean,
  ): Promise<void> {
    const list = await this.repos.list(false);
    const header = formatRepoListHeader({
      count: list.length,
      syncedAt: this.repos.lastLoadedAt(),
      forced,
      fromCache: fromCacheOnly && !forced,
    });
    if (list.length === 0) {
      await this.sendOut(
        target,
        `${header}\n${formatRepoListEmpty()}`,
      );
      return;
    }
    const entries = list.map((r, i) =>
      formatRepoListEntryHtml(i + 1, r.url, this.repos.slug(r.url)),
    );
    const fullHtml = [header, ...entries, formatRepoListFooter()].join("\n\n");
    if (fullHtml.length <= TELEGRAM_TEXT_LIMIT) {
      await this.sendOut(target, fullHtml, { parseMode: "HTML" });
      return;
    }
    await this.sendOut(target, header, { parseMode: "HTML" });
    for (const entry of entries) {
      await this.sendOut(target, entry, { parseMode: "HTML" });
    }
    await this.sendOut(target, formatRepoListFooter(), { parseMode: "HTML" });
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
    const prefModel = this.store.resolveModelId(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    const prefLabel = this.models.formatIdLabel(prefModel);
    let modelLine = `model: ${prefLabel}`;
    if (agentId) {
      const live = this.cursor.getCachedAgentModel(agentId);
      if (live) {
        const liveLabel = this.models.formatIdLabel(live);
        if (liveLabel !== prefLabel) {
          modelLine += ` (agent: ${liveLabel})`;
        }
      }
    }
    const lines = [
      `chatKind: ${msg.chatKind}`,
      `slug: ${thread?.slug ?? (msg.chatKind === "dm" ? `(default ${this.defaultSlug()})` : "(not bound — /repos + /bind)")}`,
      `agent: ${thread?.agent_id ?? "(none)"}`,
      `url: ${thread?.agent_url ?? "(none)"}`,
      modelLine,
      `verbose: ${verbose ? "on" : "off"}`,
      `streaming_run: ${streaming ?? "(none)"}`,
      `queue: ${queued}`,
    ];
    await this.channel.sendText(target, lines.join("\n"));
  }

  private async cmdModel(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    const args = (msg.commandArgs ?? "").trim();
    const thread = this.store.getActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    const preferred = this.store.resolveModelId(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );

    const forceRefresh =
      args.toLowerCase() === "refresh" ||
      args === "刷新" ||
      args.toLowerCase() === "reload";

    if (!args || forceRefresh) {
      try {
        const all = await this.models.list(forceRefresh);
        const picker = this.models.pickerModels(all, 15);
        const prefLabel = this.models.formatIdLabel(preferred, all);
        let agentLabel: string | undefined;
        if (thread?.agent_id) {
          const live = this.cursor.getCachedAgentModel(thread.agent_id);
          if (live) agentLabel = this.models.formatIdLabel(live, all);
        }
        const header = formatModelListHeader({
          preferenceLabel: prefLabel,
          agentModelLabel: agentLabel,
          forced: forceRefresh,
        });
        const lines = [header];
        picker.forEach((m, i) => {
          lines.push(
            formatModelListEntry(i + 1, m.id, m.displayName, preferred),
          );
        });
        lines.push(formatModelListFooter());
        await this.sendOut(target, lines.join("\n"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.sendOut(target, formatCursorError(message));
      }
      return;
    }

    try {
      const all = await this.models.list(false);
      const resolved = this.models.resolveToken(args, all, 15);
      if (!resolved) {
        await this.sendOut(target, formatModelNotFound(args));
        return;
      }
      const nextId =
        resolved === "auto" ||
        (typeof resolved !== "string" && isAutoModelId(resolved.id))
          ? AUTO_MODEL_ID
          : resolved.id;
      const verbose = this.verboseFor(msg);
      logModel(
        verbose,
        `outpost: model cmd set thread=${msg.threadId} chat=${msg.chatId} token=${args} resolved=${resolved === "auto" ? "auto" : resolved.id} nextId=${nextId} prev=${preferred ?? "auto"} agent=${thread?.agent_id ?? "none"}`,
      );
      this.store.setThreadModel(
        msg.channel,
        msg.chatId,
        msg.threadId,
        nextId,
      );
      const stored = this.store.resolveModelId(
        msg.channel,
        msg.chatId,
        msg.threadId,
      );
      logModel(
        verbose,
        `outpost: model cmd db stored=${stored ?? "auto"} thread=${msg.threadId}`,
      );
      if (thread?.agent_id) {
        await this.cursor.applyAgentModel(thread.agent_id, nextId, verbose);
        const live = this.cursor.getCachedAgentModel(thread.agent_id);
        logModel(
          verbose,
          `outpost: model cmd applied agent=${thread.agent_id} live=${live ?? "unset"}`,
        );
      } else {
        logModel(
          verbose,
          `outpost: model cmd skip apply (no agent yet) thread=${msg.threadId}`,
        );
      }
      const label = this.models.formatIdLabel(nextId, all);
      let reply = formatModelSet(label);
      if (thread?.agent_id) {
        reply += "\n已同步到当前 agent（Agents Window 应显示该选择）。";
      }
      await this.sendOut(target, reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, formatCursorError(message));
    }
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
      const oldAgentId = thread.agent_id;
      const cleared = this.queue.clear(oldAgentId);
      if (cleared > 0) {
        await this.sendOut(target, formatQueueDiscarded(cleared));
      }
      this.streams.clearAgent(oldAgentId);
      this.cursor.clearAgentCache(oldAgentId);
      this.store.clearAgentSyncState(oldAgentId);
    }
    this.store.resetThreadAgent(msg.channel, msg.chatId, msg.threadId);
    await this.sendOut(target, formatNewSession());
  }

  private releaseThreadBinding(agentId: string): number {
    return this.queue.clear(agentId);
  }

  private async cmdResume(
    msg: IncomingMessage,
    target: OutgoingTarget,
  ): Promise<void> {
    const args = (msg.commandArgs ?? "").trim();
    const thread = this.store.getActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );

    let slug: string | undefined;
    let projectRepo: string | undefined;
    if (msg.chatKind === "dm") {
      slug = this.defaultSlug();
      projectRepo = this.defaultProject().repo_url;
    } else if (msg.chatKind === "topic") {
      const binding = this.store.resolveThreadBinding(thread);
      if (binding) {
        slug = binding.slug;
        projectRepo = binding.repo_url;
      }
    }
    if (slug) {
      this.store.ensureActiveThread(
        msg.channel,
        msg.chatId,
        msg.threadId,
        slug,
      );
    }

    const forceRefresh =
      args === "refresh" || args === "更新" || args.toLowerCase() === "reload";

    if (forceRefresh) {
      try {
        const n = await this.catalog.refresh(true);
        if (n >= 0) {
          await this.sendOut(target, formatSessionRefreshOk(n));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.sendOut(target, formatCursorError(message));
        return;
      }
    }

    const listOnly =
      !args ||
      args === "list" ||
      args === "列表" ||
      args === "refresh" ||
      args === "更新" ||
      args.toLowerCase() === "reload";

    if (listOnly) {
      if (!forceRefresh) {
        const refreshed = await this.catalog.refresh(false);
        if (refreshed === -1) {
          await this.sendOut(target, formatSessionCacheFresh());
        }
      }
      await this.sendSessionList(
        target,
        thread?.agent_id ?? undefined,
        slug,
        projectRepo,
      );
      return;
    }

    const pickToken = args;

    const row = this.catalog.findInProject(projectRepo, pickToken);
    if (!row && pickToken.startsWith("bc-")) {
      try {
        const agent = await this.cursor.warmAgent(pickToken);
        await this.bindResumedAgent(msg, target, thread, agent);
        return;
      } catch {
        await this.sendOut(target, formatSessionNotFound(pickToken));
        return;
      }
    }
    if (!row) {
      await this.sendOut(target, formatSessionNotFound(pickToken));
      return;
    }

    if (row.archived) {
      await this.sendOut(
        target,
        "该 agent 已 archived，Cursor 可能无法继续 follow-up。可在 Agents Window 先 unarchive。",
      );
      return;
    }

    try {
      const agent = await this.cursor.warmAgent(row.agent_id);
      await this.bindResumedAgent(msg, target, thread, agent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, formatCursorError(message));
    }
  }

  private async bindResumedAgent(
    msg: IncomingMessage,
    target: OutgoingTarget,
    thread: ReturnType<Store["getActiveThread"]>,
    agent: { id: string; url: string; name?: string },
  ): Promise<void> {
    if (thread?.agent_id && thread.agent_id !== agent.id) {
      const cleared = this.releaseThreadBinding(thread.agent_id);
      if (cleared > 0) {
        await this.sendOut(target, formatQueueDiscarded(cleared));
      }
      this.streams.clearAgent(thread.agent_id);
      this.cursor.clearAgentCache(thread.agent_id);
    }
    this.store.setThreadAgent(
      msg.channel,
      msg.chatId,
      msg.threadId,
      agent.id,
      agent.url,
    );
    const modelPref = this.store.resolveModelId(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    try {
      await this.cursor.applyAgentModel(agent.id, modelPref, this.verboseFor(msg));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.sendOut(target, formatCursorError(message));
      return;
    }
    const cached = this.store.listCachedAgents(500, true).find(
      (r) => r.agent_id === agent.id,
    );
    let labelRow: CachedAgentRow = cached ?? {
      agent_id: agent.id,
      name: agent.name ?? agent.id,
      summary: "",
      display_name: null,
      status: null,
      archived: 0,
      repos_json: null,
      last_modified: 0,
      synced_at: "",
    };
    if (
      !labelRow.display_name?.trim() &&
      isGenericAgentName(labelRow.name)
    ) {
      const enriched = await this.catalog.enrichDisplayNames([labelRow]);
      labelRow = enriched[0] ?? labelRow;
    }
    await this.sendOut(
      target,
      formatSessionResumed(this.catalog.displayLabel(labelRow), agent.url),
    );
  }

  private async sendSessionList(
    target: OutgoingTarget,
    currentAgentId: string | undefined,
    projectSlug: string | undefined,
    projectRepo: string | undefined,
  ): Promise<void> {
    const rows = await this.catalog.enrichStatuses(
      await this.catalog.enrichDisplayNames(
        this.catalog.listForProject(projectRepo, 15),
      ),
    );
    const headerOpts = {
      projectSlug,
      syncedAt: this.catalog.lastSyncedAt(),
      count: rows.length,
      forced: false,
    };
    if (rows.length === 0) {
      await this.sendOut(
        target,
        `${formatSessionListHeader(headerOpts)}(empty — try /resume refresh or create an agent in Cursor)`,
      );
      return;
    }

    const htmlHeader = formatSessionListHeaderHtml(headerOpts);
    const tableChunks = formatSessionListTableHtmlChunks(
      rows,
      currentAgentId,
      TELEGRAM_TEXT_LIMIT - htmlHeader.length - 200,
    );
    const htmlFooter = formatSessionListFooterHtml();

    if (tableChunks.length === 1) {
      const fullHtml = [htmlHeader, tableChunks[0]!, htmlFooter].join("\n\n");
      if (fullHtml.length <= TELEGRAM_TEXT_LIMIT) {
        await this.sendOut(target, fullHtml, { parseMode: "HTML" });
        return;
      }
    }

    await this.sendOut(target, htmlHeader, { parseMode: "HTML" });
    for (const chunk of tableChunks) {
      await this.sendOut(target, chunk, { parseMode: "HTML" });
    }
    await this.sendOut(target, htmlFooter, { parseMode: "HTML" });
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
    let project: { slug: string; repo_url: string; ref: string };
    if (msg.chatKind === "dm") {
      project = this.defaultProject();
    } else if (msg.chatKind === "topic") {
      const existing = this.store.getActiveThread(
        msg.channel,
        msg.chatId,
        msg.threadId,
      );
      const binding = this.store.resolveThreadBinding(existing);
      if (!binding) {
        await this.channel.sendText(
          target,
          "本 topic 未绑定仓库。\n先 /repos 查看列表，再 /bind 3 或 /bind fluxalpha",
        );
        return;
      }
      project = binding;
    } else {
      return;
    }

    const thread = this.store.ensureActiveThread(
      msg.channel,
      msg.chatId,
      msg.threadId,
      project.slug,
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
      const modelId = this.store.resolveModelId(
        msg.channel,
        msg.chatId,
        msg.threadId,
      );
      const verbose = this.verboseFor(msg);
      logModel(
        verbose,
        `outpost: model startCreate thread=${msg.threadId} pref=${modelId ?? "auto"}`,
      );
      const created = await this.cursor.createAgent({
        text: promptText,
        repoUrl: project.repo_url,
        startingRef: project.ref,
        images,
        model: modelId,
        modelLog: verbose,
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
      runId,
    );

    await this.deliverRun({
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
    const modelId = this.store.resolveModelId(
      msg.channel,
      msg.chatId,
      msg.threadId,
    );
    const verbose = this.verboseFor(msg);
    logModel(
      verbose,
      `outpost: model startFollowUp thread=${msg.threadId} agent=${agentId} pref=${modelId ?? "auto"}`,
    );
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
        created = await this.cursor.createRun(
          agentId,
          promptText,
          images,
          modelId,
          verbose,
        );
      } catch (err) {
        if (err instanceof CursorApiError && err.status === 409) {
          await this.workUpdate(target, formatAgentBusyRetry());
          await this.waitUntilAgentIdle(agentId);
          created = await this.cursor.createRun(
            agentId,
            promptText,
            images,
            modelId,
            verbose,
          );
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
      runId,
    );

    await this.deliverRun({
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
