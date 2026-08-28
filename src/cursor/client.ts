/**
 * Cursor Cloud Agents HTTP client (fetch only).
 * @see https://cursor.com/docs/cloud-agent/api/endpoints
 */

import type {
  Agent,
  Conversation,
  CreateAgentRequest,
  CreateAgentResponse,
  CreateRunRequest,
  CreateRunResponse,
  ListResult,
  PromptImage,
  Run,
  RunStatus,
  StreamEvent,
} from "./types.js";

export type CursorClientOptions = {
  apiKey: string;
  apiBase?: string;
};

const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function networkCause(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const c = err.cause;
  if (c instanceof Error) return c.message;
  if (c && typeof c === "object" && "code" in c) {
    return String((c as { code: unknown }).code);
  }
  return undefined;
}

/** Human-readable network failure (fetch threw before HTTP response). */
export function formatCursorFetchError(url: string, err: unknown): string {
  if (err instanceof CursorApiError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  const cause = networkCause(err);
  return `Cursor network error ${url}: ${msg}${cause ? ` (${cause})` : ""}`;
}

async function fetchWithRetry(url: string, opts: RequestInit): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < FETCH_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      last = err;
      if (attempt + 1 < FETCH_RETRY_ATTEMPTS) {
        await sleep(FETCH_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  const wrapped = new Error(formatCursorFetchError(url, last));
  wrapped.cause = last;
  throw wrapped;
}

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

/** Official shape is often `{ error: { code, message } }`. */
function parseApiErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { code?: string; message?: string };
      code?: string;
    };
    if (typeof parsed.error === "object" && parsed.error?.code) {
      return parsed.error.code;
    }
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.code;
  } catch {
    return undefined;
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

export class CursorClient {
  private readonly apiKey: string;
  private readonly apiBase: string;

  /** Vision model for prompts that include images. */
  static readonly IMAGE_MODEL_ID = "composer-2.5";

  constructor(opts: CursorClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiBase = (opts.apiBase ?? "https://api.cursor.com/v1").replace(/\/$/, "");
  }

  private authHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    return headers;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers = this.authHeaders();
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const url = `${this.apiBase}${path}`;
    const res = await fetchWithRetry(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new CursorApiError(res.status, text, parseApiErrorCode(text));
    }
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /** Read-only probe: list agents with limit=1. */
  async probe(): Promise<void> {
    await this.listAgents({ limit: 1 });
  }

  async listAgents(params?: {
    limit?: number;
    cursor?: string;
    includeArchived?: boolean;
  }): Promise<ListResult<Agent>> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.cursor) q.set("cursor", params.cursor);
    if (params?.includeArchived) q.set("includeArchived", "true");
    const qs = q.toString();
    return this.requestJson("GET", `/agents${qs ? `?${qs}` : ""}`);
  }

  async getAgent(agentId: string): Promise<Agent> {
    return this.requestJson("GET", `/agents/${encodeURIComponent(agentId)}`);
  }

  /**
   * Create agent + initial run.
   * Always sends autoCreatePR: false; never sends workOnCurrentBranch or env.
   */
  async createAgent(input: {
    text: string;
    repoUrl: string;
    startingRef: string;
    name?: string;
    images?: PromptImage[];
  }): Promise<CreateAgentResponse> {
    if (input.images?.length) {
      const body = buildCreateAgentBody(input);
      console.log(
        `outpost: cursor createAgent images=${input.images.length} model=${body.model?.id} mime=${input.images[0]?.mimeType} jsonBytes~${JSON.stringify(body).length}`,
      );
    }
    return this.requestJson("POST", "/agents", buildCreateAgentBody(input));
  }

  async createRun(
    agentId: string,
    text: string,
    images?: PromptImage[],
  ): Promise<CreateRunResponse> {
    const body: CreateRunRequest = {
      prompt: images?.length ? { text, images } : { text },
    };
    if (images?.length) {
      body.model = { id: CursorClient.IMAGE_MODEL_ID };
      console.log(
        `outpost: cursor createRun images=${images.length} model=${body.model.id} mime=${images[0]?.mimeType} jsonBytes~${JSON.stringify(body).length}`,
      );
    }
    return this.requestJson(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/runs`,
      body,
    );
  }

  async listRuns(
    agentId: string,
    params?: { limit?: number; cursor?: string },
  ): Promise<ListResult<Run>> {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return this.requestJson(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/runs${qs ? `?${qs}` : ""}`,
    );
  }

  async getRun(agentId: string, runId: string): Promise<Run> {
    return this.requestJson(
      "GET",
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  async cancelRun(agentId: string, runId: string): Promise<{ id: string }> {
    return this.requestJson(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
    );
  }

  /**
   * User prompts are not on v1 getRun. Legacy v0 conversation still returns them.
   * @see https://cursor.com/docs/cloud-agent/api/v0
   */
  async getConversation(agentId: string): Promise<Conversation> {
    const v0Base = this.apiBase.replace(/\/v1\/?$/, "/v0");
    const url = `${v0Base}/agents/${encodeURIComponent(agentId)}/conversation`;
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new CursorApiError(res.status, text, parseApiErrorCode(text));
    }
    return JSON.parse(text) as Conversation;
  }

  /**
   * Stream SSE for one run. Yields simplified events; ignores interaction_update.
   * On 410 / 409 stream_unavailable, throws CursorApiError — caller should getRun.
   */
  async *streamRun(
    agentId: string,
    runId: string,
    opts?: { lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const headers = this.authHeaders({ Accept: "text/event-stream" });
    if (opts?.lastEventId) {
      headers.set("Last-Event-ID", opts.lastEventId);
    }

    const streamUrl = `${this.apiBase}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
    const res = await fetchWithRetry(streamUrl, {
      method: "GET",
      headers,
      signal: opts?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CursorApiError(res.status, text, parseApiErrorCode(text));
    }

    if (!res.body) {
      throw new CursorApiError(res.status, "empty stream body");
    }

    yield* parseSseStream(res.body);
  }
}

/** Exported for step-3 field checks; not a public product API. */
export function buildCreateAgentBody(input: {
  text: string;
  repoUrl: string;
  startingRef: string;
  name?: string;
  images?: PromptImage[];
}): CreateAgentRequest {
  const prompt =
    input.images?.length
      ? { text: input.text, images: input.images }
      : { text: input.text };
  const body: CreateAgentRequest = {
    prompt,
    repos: [{ url: input.repoUrl, startingRef: input.startingRef }],
    autoCreatePR: false,
  };
  if (input.images?.length) {
    body.model = { id: CursorClient.IMAGE_MODEL_ID };
  }
  if (input.name) {
    body.name = input.name;
  }
  return body;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const flush = (): StreamEvent | undefined => {
    if (dataLines.length === 0 && eventId === undefined) {
      eventName = "message";
      return undefined;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const id = eventId;
    eventId = undefined;
    const name = eventName;
    eventName = "message";

    if (name === "interaction_update") {
      return undefined;
    }

    let data: unknown = {};
    if (raw) {
      try {
        data = JSON.parse(raw) as unknown;
      } catch {
        data = { raw };
      }
    }

    return toStreamEvent(name, data, id);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let valuePart = colon === -1 ? "" : line.slice(colon + 1);
        if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);

        if (field === "event") {
          eventName = valuePart;
        } else if (field === "data") {
          dataLines.push(valuePart);
        } else if (field === "id") {
          eventId = valuePart;
        }
      }
    }
    decoder.decode();
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

function toStreamEvent(
  name: string,
  data: unknown,
  id?: string,
): StreamEvent {
  const obj = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "status":
      return {
        type: "status",
        id,
        data: {
          runId: String(obj.runId ?? ""),
          status: obj.status as RunStatus,
        },
      };
    case "assistant":
      return { type: "assistant", id, data: { text: String(obj.text ?? "") } };
    case "thinking":
      return { type: "thinking", id, data: { text: String(obj.text ?? "") } };
    case "tool_call":
      return {
        type: "tool_call",
        id,
        data: {
          callId: String(obj.callId ?? ""),
          name: String(obj.name ?? ""),
          status: obj.status as "running" | "completed",
          args: obj.args,
          result: obj.result,
          truncated: obj.truncated as
            | { args?: true; result?: true }
            | undefined,
        },
      };
    case "result":
      return {
        type: "result",
        id,
        data: {
          runId: String(obj.runId ?? ""),
          status: obj.status as RunStatus,
          text: obj.text != null ? String(obj.text) : undefined,
          durationMs:
            typeof obj.durationMs === "number" ? obj.durationMs : undefined,
          git: obj.git as Run["git"],
        },
      };
    case "error":
      return {
        type: "error",
        id,
        data: {
          code: String(obj.code ?? "error"),
          message: String(obj.message ?? ""),
        },
      };
    case "done":
      return { type: "done", id, data: {} };
    case "heartbeat":
      return { type: "heartbeat", id, data: obj };
    default:
      return { type: "unknown", id, event: name, data };
  }
}
