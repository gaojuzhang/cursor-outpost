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
  type SDKUserMessage,
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
import {
  agentUrl,
  mapSdkAgentInfo,
  mapSdkMessage,
  mapSdkRun,
  resultEventFromRun,
} from "./sdk-map.js";

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

  private async resumeAgent(agentId: string): Promise<SDKAgent> {
    const cached = this.agentHandles.get(agentId);
    if (cached) return cached;
    const handle = await SdkAgentClass.resume(agentId, this.cloudOpts());
    this.agentHandles.set(agentId, handle);
    return handle;
  }

  private cacheRun(run: SdkRun): SdkRun {
    this.runHandles.set(run.id, run);
    return run;
  }

  private async fetchRun(agentId: string, runId: string): Promise<SdkRun> {
    const cached = this.runHandles.get(runId);
    if (cached && cached.agentId === agentId) return cached;
    const run = await SdkAgentClass.getRun(runId, {
      runtime: "cloud",
      agentId,
      apiKey: this.apiKey,
    });
    return this.cacheRun(run);
  }

  /** Read-only probe: account + list agents. */
  async probe(): Promise<void> {
    await Cursor.me(this.cloudOpts());
    await SdkAgentClass.list({ runtime: "cloud", limit: 1, ...this.cloudOpts() });
  }

  async listAgents(params?: {
    limit?: number;
    cursor?: string;
    includeArchived?: boolean;
  }): Promise<ListResult<Agent>> {
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
  }

  async getAgent(agentId: string): Promise<Agent> {
    const info = await SdkAgentClass.get(agentId, this.cloudOpts());
    return mapSdkAgentInfo(info);
  }

  async createAgent(input: {
    text: string;
    repoUrl: string;
    startingRef: string;
    name?: string;
    images?: PromptImage[];
  }): Promise<CreateAgentResponse> {
    try {
      const handle = await SdkAgentClass.create({
        ...this.cloudOpts(),
        name: input.name,
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
      const run = await handle.send(toUserMessage(input.text, input.images));
      this.cacheRun(run);
      if (input.images?.length) {
        console.log(
          `outpost: sdk createAgent images=${input.images.length} model=${handle.model?.id ?? "inherit"} mime=${input.images[0]?.mimeType}`,
        );
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
  ): Promise<CreateRunResponse> {
    try {
      const handle = await this.resumeAgent(agentId);
      const run = await handle.send(toUserMessage(text, images));
      this.cacheRun(run);
      if (images?.length) {
        console.log(
          `outpost: sdk createRun images=${images.length} model=${handle.model?.id ?? "inherit"} mime=${images[0]?.mimeType}`,
        );
      }
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
      throw new CursorApiError(res.status, text);
    }
    return JSON.parse(text) as Conversation;
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

    if (!run.supports("stream")) {
      const reason = run.unsupportedReason("stream") ?? "stream_unavailable";
      throw new CursorApiError(409, reason, "stream_unavailable");
    }

    try {
      for await (const msg of run.stream()) {
        const ev = mapSdkMessage(msg);
        if (ev) yield ev;
      }

      let finalRun = run;
      if (run.supports("wait")) {
        try {
          const waited = await run.wait();
          finalRun = {
            ...run,
            status: waited.status,
            result: waited.result ?? run.result,
            durationMs: waited.durationMs ?? run.durationMs,
            git: waited.git ?? run.git,
            model: waited.model ?? run.model,
          };
          this.cacheRun(finalRun);
        } catch {
          finalRun = await this.fetchRun(agentId, runId);
        }
      } else {
        finalRun = await this.fetchRun(agentId, runId);
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
