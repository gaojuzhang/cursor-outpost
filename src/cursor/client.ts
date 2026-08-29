/**
 * Cursor Cloud Agents client via @cursor/sdk (public beta).
 * Keeps the Outpost-facing API used by router/poller.
 */

import {
  Agent as SdkAgentClass,
  AgentBusyError,
  Cursor,
  CursorAgentError,
  type Run as SdkRun,
  type SDKAgent,
  type SDKModel,
  type SDKUserMessage,
  type SDKMessage,
  type SendOptions,
} from "@cursor/sdk";
import type {
  Agent,
  Conversation,
  CreateAgentResponse,
  CreateRunResponse,
  ListResult,
  PromptImage,
  Run,
  StreamEvent,
} from "./types.js";
import { isTerminalRunStatus } from "./types.js";
import {
  agentUrl,
  mapSdkAgentInfo,
  mapSdkMessage,
  mapSdkRun,
  mapSdkRunStatus,
  resultEventFromRun,
} from "./sdk-map.js";
import { deriveAgentNameFromPrompt } from "../core/agent-label.js";
import { logModel } from "../core/model-log.js";
import { effectiveModelForSend } from "../core/model-prefs.js";

export type CursorClientOptions = {
  apiKey: string;
  apiBase?: string;
};

export class CursorApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code: string | undefined;

  constructor(status: number, body: string, code?: string) {
    const snippet = body.slice(0, 200).replace(/\s+/g, " ");
    super(`Cursor API HTTP ${status}${snippet ? `: ${snippet}` : ""}`);
    this.name = "CursorApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/** Stream retention gone — caller should fall back to getRun. */
export function isStreamGoneError(err: unknown): err is CursorApiError {
  if (!(err instanceof CursorApiError)) return false;
  if (err.status === 410) return true;
  if (err.status === 409 && err.code === "stream_unavailable") return true;
  return err.code === "stream_expired" || err.code === "stream_unavailable";
}

export function isStreamGoneCode(code: string | undefined): boolean {
  return code === "stream_expired" || code === "stream_unavailable";
}

/** Agent gone from Cursor (deleted/archived) — clear local thread binding. */
export function isStaleAgentError(err: unknown): boolean {
  if (!(err instanceof CursorApiError)) return false;
  if (err.status === 404) return true;
  if (err.code === "agent_not_found") return true;
  const body = err.body.toLowerCase();
  if (
    body.includes("agent is deleted") ||
    body.includes("agent deleted") ||
    body.includes("archived") ||
    body.includes("not found")
  ) {
    return true;
  }
  if (err.status === 409 && body.includes("deleted")) return true;
  return false;
}

function parseErrorBody(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { code?: string; message?: string };
      code?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error === "object" && parsed.error?.code) {
      return parsed.error.code;
    }
    return parsed.code;
  } catch {
    return undefined;
  }
}

/** @deprecated SDK path — kept for callers that format fetch errors. */
export function formatCursorFetchError(url: string, err: unknown): string {
  if (err instanceof CursorApiError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  return `Cursor network error ${url}: ${msg}`;
}

function toUserMessage(
  text: string,
  images?: PromptImage[],
): string | SDKUserMessage {
  if (!images?.length) return text;
  return {
    text,
    images: images.map((img) => ({
      data: img.data,
      mimeType: img.mimeType,
      dimension: img.dimension,
    })),
  };
}

function hasRunCapabilities(run: SdkRun): boolean {
  return typeof run.supports === "function";
}

type RunCapability = Parameters<SdkRun["supports"]>[0];

function runSupports(run: SdkRun, capability: RunCapability): boolean {
  return hasRunCapabilities(run) && run.supports(capability);
}

function wrapSdkError(err: unknown): CursorApiError {
  if (err instanceof CursorApiError) return err;
  if (err instanceof AgentBusyError) {
    return new CursorApiError(409, err.message, err.code ?? "agent_busy");
  }
  if (err instanceof CursorAgentError) {
    const status = err.status ?? 500;
    return new CursorApiError(status, err.message, err.code);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new CursorApiError(500, msg);
}

function sendOptionsForModel(
  preferred: string | null | undefined,
): SendOptions {
  return { model: { id: effectiveModelForSend(preferred) } };
}

function createOptionsForModel(
  preferred: string | null | undefined,
): { model: { id: string } } {
  return { model: { id: effectiveModelForSend(preferred) } };
}

const SDK_RUN_POLL_MS = 2500;
const SDK_RUN_WAIT_MAX_MS = 90_000;
const SDK_STREAM_MAX_MS = 90_000;

function isSdkRunRunning(status: string): boolean {
  return mapSdkRunStatus(status) === "RUNNING";
}

/** Terminal run with no result — often a stale handle right after send() on first create. */
function isStaleTerminalRun(run: SdkRun): boolean {
  const mapped = mapSdkRunStatus(run.status);
  if (!isTerminalRunStatus(mapped)) return false;
  return !run.result?.trim();
}

export function isStaleTerminalSnapshot(snap: RunTerminalSnapshot): boolean {
  if (!snap.isTerminal) return false;
  return !snap.result?.trim();
}

export type RunTerminalSnapshot = {
  status: string;
  result?: string;
  git?: SdkRun["git"];
  usage?: SdkRun["usage"];
  isTerminal: boolean;
};

export class CursorClient {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly agentHandles = new Map<string, SDKAgent>();
  private readonly runHandles = new Map<string, SdkRun>();

  constructor(opts: CursorClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiBase = (opts.apiBase ?? "https://api.cursor.com/v1").replace(/\/$/, "");
  }

  private cloudOpts() {
    return { apiKey: this.apiKey };
  }

  private async resumeAgent(
    agentId: string,
    preferred?: string | null,
    modelLog = false,
  ): Promise<SDKAgent> {
    const effective = effectiveModelForSend(preferred);
    const cached = this.agentHandles.get(agentId);
    const cachedId = cached?.model?.id;
    if (cached && preferred === undefined) {
      logModel(
        modelLog,
        `outpost: model resumeAgent cache hit agent=${agentId} handleModel=${cachedId ?? "unset"}`,
      );
      return cached;
    }
    if (cached && cachedId === effective) {
      logModel(
        modelLog,
        `outpost: model resumeAgent cache ok agent=${agentId} model=${effective}`,
      );
      return cached;
    }
    logModel(
      modelLog,
      `outpost: model resumeAgent re-resume agent=${agentId} pref=${preferred ?? "auto"} effective=${effective} cached=${cachedId ?? "unset"}`,
    );
    const handle = await SdkAgentClass.resume(agentId, {
      ...this.cloudOpts(),
      model: { id: effective },
    });
    this.agentHandles.set(agentId, handle);
    logModel(
      modelLog,
      `outpost: model resumeAgent done agent=${agentId} handleModel=${handle.model?.id ?? "unset"}`,
    );
    return handle;
  }

  private cacheRun(run: SdkRun): SdkRun {
    if (!hasRunCapabilities(run)) return run;
    this.runHandles.set(run.id, run);
    return run;
  }

  private invalidateRunCache(runId: string): void {
    this.runHandles.delete(runId);
  }

  private async fetchRun(
    agentId: string,
    runId: string,
    opts?: { force?: boolean },
  ): Promise<SdkRun> {
    if (opts?.force) {
      this.invalidateRunCache(runId);
    } else {
      const cached = this.runHandles.get(runId);
      if (cached && cached.agentId === agentId && hasRunCapabilities(cached)) {
        if (!isStaleTerminalRun(cached)) return cached;
        this.invalidateRunCache(runId);
      }
    }
    const run = await SdkAgentClass.getRun(runId, {
      runtime: "cloud",
      agentId,
      apiKey: this.apiKey,
    });
    return this.cacheRun(run);
  }

  private runSnapshotFromSdk(run: SdkRun): RunTerminalSnapshot {
    return {
      status: run.status,
      result: run.result,
      git: run.git,
      usage: run.usage,
      isTerminal: isTerminalRunStatus(mapSdkRunStatus(run.status)),
    };
  }

  /** Bounded wait + poll — SDK wait()/stream can hang after run already finished in UI. */
  private async waitSdkRunDone(
    agentId: string,
    runId: string,
    run: SdkRun,
    maxMs = SDK_RUN_WAIT_MAX_MS,
  ): Promise<SdkRun> {
    if (!isSdkRunRunning(run.status) && !isStaleTerminalRun(run)) return run;

    if (runSupports(run, "wait") && isSdkRunRunning(run.status) && maxMs > 0) {
      try {
        await Promise.race([
          run.wait(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("sdk_run_wait_timeout")), maxMs),
          ),
        ]);
        this.invalidateRunCache(runId);
        const refreshed = await this.fetchRun(agentId, runId);
        if (!isSdkRunRunning(refreshed.status) && !isStaleTerminalRun(refreshed)) {
          return refreshed;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "sdk_run_wait_timeout") {
          console.warn(
            `outpost: sdk run.wait failed agent=${agentId} run=${runId}: ${msg}`,
          );
        }
      }
    }

    const started = Date.now();
    while (Date.now() - started < maxMs) {
      this.invalidateRunCache(runId);
      const refreshed = await this.fetchRun(agentId, runId);
      if (!isSdkRunRunning(refreshed.status) && !isStaleTerminalRun(refreshed)) {
        return refreshed;
      }
      await new Promise((r) => setTimeout(r, SDK_RUN_POLL_MS));
    }
    return await this.fetchRun(agentId, runId);
  }

  /** Read-only probe: account + list agents. */
  async probe(): Promise<void> {
    await Cursor.me(this.cloudOpts());
    await SdkAgentClass.list({ runtime: "cloud", limit: 1, ...this.cloudOpts() });
  }

  async listModels(): Promise<SDKModel[]> {
    try {
      return await Cursor.models.list(this.cloudOpts());
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** GitHub repos connected to Cursor (Cloud Agents). Rate-limited — cache in RepoCatalog. */
  async listRepositories(): Promise<Array<{ url: string }>> {
    try {
      return await Cursor.repositories.list(this.cloudOpts());
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  async listAgents(params?: {
    limit?: number;
    cursor?: string;
    includeArchived?: boolean;
  }): Promise<ListResult<Agent>> {
    try {
      const listed = await SdkAgentClass.list({
        runtime: "cloud",
        limit: params?.limit,
        cursor: params?.cursor,
        includeArchived: params?.includeArchived,
        ...this.cloudOpts(),
      });
      return {
        items: listed.items.map(mapSdkAgentInfo),
        nextCursor: listed.nextCursor,
      };
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** Paginated cloud agent list for local session catalog. */
  async fetchAllCloudAgents(opts?: {
    includeArchived?: boolean;
    pageSize?: number;
  }): Promise<
    Array<{
      agentId: string;
      name: string;
      summary: string;
      status?: string;
      archived?: boolean;
      lastModified: number;
      repos?: string[];
    }>
  > {
    const pageSize = opts?.pageSize ?? 50;
    const out: Array<{
      agentId: string;
      name: string;
      summary: string;
      status?: string;
      archived?: boolean;
      lastModified: number;
      repos?: string[];
    }> = [];
    let cursor: string | undefined;
    try {
      for (;;) {
        const listed = await SdkAgentClass.list({
          runtime: "cloud",
          limit: pageSize,
          cursor,
          includeArchived: opts?.includeArchived ?? true,
          ...this.cloudOpts(),
        });
        for (const info of listed.items) {
          out.push({
            agentId: info.agentId,
            name: info.name,
            summary: info.summary,
            status: info.status,
            archived: info.archived,
            lastModified: info.lastModified,
            repos:
              info.runtime === "cloud" ? info.repos : undefined,
          });
        }
        if (!listed.nextCursor) break;
        cursor = listed.nextCursor;
      }
      await this.enrichMissingAgentStatuses(out);
      return out;
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** List API often omits run status — fill via Agent.get. */
  private async enrichMissingAgentStatuses(
    items: Array<{ agentId: string; status?: string }>,
  ): Promise<void> {
    const missing = items.filter((item) => !item.status?.trim());
    if (missing.length === 0) return;
    await Promise.all(
      missing.map(async (item) => {
        try {
          item.status = await this.getAgentSdkStatus(item.agentId);
        } catch {
          /* deleted or unavailable */
        }
      }),
    );
  }

  /** Resume SDK handle for an existing cloud agent (follow-ups use this agent). */
  async warmAgent(agentId: string): Promise<Agent> {
    try {
      const handle = await SdkAgentClass.resume(agentId, this.cloudOpts());
      this.agentHandles.set(agentId, handle);
      return mapSdkAgentInfo(await SdkAgentClass.get(agentId, this.cloudOpts()));
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /**
   * Push model preference onto a cloud agent without sending a message.
   * `Agent.resume({ model })` updates the SDK handle (and Agents Window).
   */
  async applyAgentModel(
    agentId: string,
    preferred: string | null,
    modelLog = false,
  ): Promise<void> {
    try {
      const effective = effectiveModelForSend(preferred);
      const before = this.agentHandles.get(agentId)?.model?.id;
      logModel(
        modelLog,
        `outpost: model applyAgentModel agent=${agentId} pref=${preferred ?? "auto"} effective=${effective} handleBefore=${before ?? "unset"}`,
      );
      const handle = await SdkAgentClass.resume(agentId, {
        ...this.cloudOpts(),
        model: { id: effective },
      });
      this.agentHandles.set(agentId, handle);
      logModel(
        modelLog,
        `outpost: model applyAgentModel ok agent=${agentId} handleAfter=${handle.model?.id ?? "unset"}`,
      );
    } catch (err) {
      if (modelLog) {
        console.error(
          `outpost: model applyAgentModel failed agent=${agentId} pref=${preferred ?? "auto"}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw wrapSdkError(err);
    }
  }

  async getAgent(agentId: string): Promise<Agent> {
    const info = await SdkAgentClass.get(agentId, this.cloudOpts());
    return mapSdkAgentInfo(info);
  }

  /** Latest run execution status from cloud API (`running` / `finished` / `error`). */
  async getAgentSdkStatus(agentId: string): Promise<string | undefined> {
    try {
      const info = await SdkAgentClass.get(agentId, this.cloudOpts());
      return info.status;
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** Result text from SDK run handle (may lag behind terminal status). */
  async getRunResultText(agentId: string, runId: string): Promise<string | undefined> {
    try {
      const snap = await this.snapshotRun(agentId, runId, { waitIfRunning: true });
      return snap.result?.trim() || undefined;
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** Snapshot run state; optionally wait() while still running. */
  async snapshotRun(
    agentId: string,
    runId: string,
    opts?: { waitIfRunning?: boolean; waitMaxMs?: number },
  ): Promise<RunTerminalSnapshot> {
    try {
      let run = await this.fetchRun(agentId, runId);
      if (
        opts?.waitIfRunning &&
        (isSdkRunRunning(run.status) || isStaleTerminalRun(run))
      ) {
        const maxMs = opts.waitMaxMs ?? SDK_RUN_WAIT_MAX_MS;
        run = await this.waitSdkRunDone(agentId, runId, run, maxMs);
      }
      return this.runSnapshotFromSdk(run);
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** Last assistant text from SDK run.conversation(). */
  async getRunConversationText(
    agentId: string,
    runId: string,
  ): Promise<string | undefined> {
    try {
      const run = await this.fetchRun(agentId, runId);
      if (!runSupports(run, "conversation")) return undefined;
      const turns = await run.conversation();
      for (let i = turns.length - 1; i >= 0; i--) {
        const step = turns[i] as { type?: string; message?: { text?: string } };
        if (step.type === "assistantMessage" && step.message?.text?.trim()) {
          return step.message.text.trim();
        }
      }
      return undefined;
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** Wait until run leaves CREATING (stream may 409 if opened too early). */
  async waitForRunActive(
    agentId: string,
    runId: string,
    maxMs = 20_000,
  ): Promise<Run> {
    const started = Date.now();
    let last = await this.getRun(agentId, runId);
    while (last.status === "CREATING" && Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 2500));
      last = await this.getRun(agentId, runId);
    }
    return last;
  }

  /**
   * Wait until run is ready to stream or resolve (first-create env setup).
   * Polls through stale terminal handles returned immediately after send().
   */
  async waitForRunDeliverable(
    agentId: string,
    runId: string,
    maxMs = 120_000,
  ): Promise<Run> {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      this.invalidateRunCache(runId);
      const run = await this.fetchRun(agentId, runId);
      const mapped = mapSdkRunStatus(run.status);

      if (mapped === "CREATING") {
        await new Promise((r) => setTimeout(r, SDK_RUN_POLL_MS));
        continue;
      }

      if (isSdkRunRunning(run.status)) {
        return mapSdkRun(run);
      }

      if (mapped === "FINISHED" && run.result?.trim()) {
        return mapSdkRun(run);
      }

      if (isStaleTerminalRun(run)) {
        await new Promise((r) => setTimeout(r, SDK_RUN_POLL_MS));
        continue;
      }

      return mapSdkRun(run);
    }

    this.invalidateRunCache(runId);
    return mapSdkRun(await this.fetchRun(agentId, runId));
  }

  /** Token usage on SDK run handle (covers poll / fast-finish paths without stream usage). */
  async getRunTokenUsage(
    agentId: string,
    runId: string,
  ): Promise<
    | {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        totalTokens: number;
        reasoningTokens?: number;
      }
    | undefined
  > {
    try {
      let run = await this.fetchRun(agentId, runId);
      if (run.usage) return run.usage;
      if (runSupports(run, "wait") && isSdkRunRunning(run.status)) {
        const waited = await this.waitSdkRunDone(agentId, runId, run, 15_000);
        if (waited.usage) return waited.usage;
      }
      run = await this.fetchRun(agentId, runId);
      return run.usage ?? undefined;
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  async createAgent(input: {
    text: string;
    repoUrl: string;
    startingRef: string;
    name?: string;
    images?: PromptImage[];
    model?: string | null;
    modelLog?: boolean;
  }): Promise<CreateAgentResponse> {
    try {
      const promptName =
        input.name?.trim() || deriveAgentNameFromPrompt(input.text);
      const sendOpts = sendOptionsForModel(input.model);
      const createModel = createOptionsForModel(input.model);
      logModel(
        input.modelLog ?? false,
        `outpost: model createAgent pref=${input.model ?? "auto"} createModel=${createModel.model?.id} sendModel=${sendOpts.model?.id}`,
      );
      const handle = await SdkAgentClass.create({
        ...this.cloudOpts(),
        ...createOptionsForModel(input.model),
        name: promptName,
        cloud: {
          repos: [
            {
              url: input.repoUrl,
              startingRef: input.startingRef,
            },
          ],
          autoCreatePR: false,
        },
      });
      this.agentHandles.set(handle.agentId, handle);
      const run = await handle.send(
        toUserMessage(input.text, input.images),
        sendOpts,
      );
      this.cacheRun(run);
      const modelId = effectiveModelForSend(
        handle.model?.id ?? sendOpts.model?.id,
      );
      if (input.modelLog) {
        if (input.images?.length) {
          console.log(
            `outpost: sdk createAgent images=${input.images.length} model=${modelId} mime=${input.images[0]?.mimeType}`,
          );
        } else {
          console.log(`outpost: sdk createAgent model=${modelId}`);
        }
      }
      return {
        agent: {
          id: handle.agentId,
          status: "ACTIVE",
          url: agentUrl(handle.agentId),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        run: mapSdkRun(run),
      };
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  async createRun(
    agentId: string,
    text: string,
    images?: PromptImage[],
    model?: string | null,
    modelLog = false,
  ): Promise<CreateRunResponse> {
    try {
      const handle = await this.resumeAgent(agentId, model, modelLog);
      const sendOpts = sendOptionsForModel(model);
      logModel(
        modelLog,
        `outpost: model createRun agent=${agentId} pref=${model ?? "auto"} sendModel=${sendOpts.model?.id} handleBeforeSend=${handle.model?.id ?? "unset"}`,
      );
      const run = await handle.send(
        toUserMessage(text, images),
        sendOpts,
      );
      this.cacheRun(run);
      const modelId = effectiveModelForSend(
        handle.model?.id ?? sendOpts.model?.id,
      );
      logModel(
        modelLog,
        `outpost: model createRun done agent=${agentId} runModel=${run.model?.id ?? "unset"} handleAfter=${handle.model?.id ?? "unset"} effective=${modelId}`,
      );
      return { run: mapSdkRun(run) };
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  async listRuns(
    agentId: string,
    params?: { limit?: number; cursor?: string },
  ): Promise<ListResult<Run>> {
    const listed = await SdkAgentClass.listRuns(agentId, {
      runtime: "cloud",
      limit: params?.limit,
      cursor: params?.cursor,
      ...this.cloudOpts(),
    });
    return {
      items: listed.items.map(mapSdkRun),
      nextCursor: listed.nextCursor,
    };
  }

  async getRun(agentId: string, runId: string): Promise<Run> {
    try {
      const run = await this.fetchRun(agentId, runId);
      return mapSdkRun(run);
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  async cancelRun(agentId: string, runId: string): Promise<{ id: string }> {
    try {
      await SdkAgentClass.cancelRun(runId, {
        runtime: "cloud",
        agentId,
        apiKey: this.apiKey,
      });
      return { id: runId };
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /**
   * User prompts are not on v1 getRun. Legacy v0 conversation still returns them.
   */
  async getConversation(agentId: string): Promise<Conversation> {
    const v0Base = this.apiBase.replace(/\/v1\/?$/, "/v0");
    const url = `${v0Base}/agents/${encodeURIComponent(agentId)}/conversation`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new CursorApiError(res.status, text, parseErrorBody(text));
    }
    return JSON.parse(text) as Conversation;
  }

  /** Drop cached SDK handles after agent deletion or thread reset. */
  clearAgentCache(agentId: string, modelLog = false): void {
    if (modelLog && this.agentHandles.has(agentId)) {
      logModel(
        true,
        `outpost: model clearAgentCache agent=${agentId} handleModel=${this.agentHandles.get(agentId)?.model?.id ?? "unset"}`,
      );
    }
    this.agentHandles.delete(agentId);
    for (const [runId, run] of this.runHandles) {
      if (run.agentId === agentId) this.runHandles.delete(runId);
    }
  }

  async *streamRun(
    agentId: string,
    runId: string,
    _opts?: { lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    let run: SdkRun;
    try {
      run = await this.fetchRun(agentId, runId);
    } catch (err) {
      throw wrapSdkError(err);
    }

    if (!runSupports(run, "stream")) {
      const reason =
        hasRunCapabilities(run)
          ? (run.unsupportedReason("stream") ?? "stream_unavailable")
          : "stream_unavailable";
      throw new CursorApiError(409, reason, "stream_unavailable");
    }

    try {
      const deadline = Date.now() + SDK_STREAM_MAX_MS;
      const iter = run.stream()[Symbol.asyncIterator]();
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          console.log(
            `outpost: stream timeout agent=${agentId} run=${runId} — resolve path`,
          );
          break;
        }
        const next = await Promise.race([
          iter.next(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), remaining),
          ),
        ]);
        if (next.done) break;
        const ev = mapSdkMessage(next.value as SDKMessage);
        if (ev) yield ev;
      }

      let finalRun = await this.fetchRun(agentId, runId);
      if (isSdkRunRunning(finalRun.status)) {
        finalRun = await this.waitSdkRunDone(
          agentId,
          runId,
          finalRun,
          SDK_RUN_WAIT_MAX_MS,
        );
      }

      yield resultEventFromRun(finalRun);
      yield { type: "done", data: {} };
    } catch (err) {
      throw wrapSdkError(err);
    }
  }

  /** Current model on an in-memory SDK handle (undefined after resume-only). */
  getCachedAgentModel(agentId: string): string | undefined {
    return this.agentHandles.get(agentId)?.model?.id;
  }
}

/** @deprecated REST helper — unused under SDK backend. */
export function buildCreateAgentBody(_input: {
  text: string;
  repoUrl: string;
  startingRef: string;
  name?: string;
  images?: PromptImage[];
}): never {
  throw new Error("buildCreateAgentBody is not used with @cursor/sdk backend");
}
