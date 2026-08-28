/** Types aligned with Cursor Cloud Agents API v1. */

export type AgentStatus = "ACTIVE" | "ARCHIVED";

export type RunStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

export type PromptImage = {
  data: string;
  mimeType: string;
  dimension?: { width: number; height: number };
};

export type ModelRef = {
  id: string;
};

export type Prompt = {
  text: string;
  images?: PromptImage[];
};

export type RepositoryInput = {
  url: string;
  startingRef?: string;
  prUrl?: string;
};

export type Agent = {
  id: string;
  name?: string;
  status: AgentStatus;
  repos?: RepositoryInput[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  latestRunId?: string;
};

export type GitBranch = {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
};

export type Run = {
  id: string;
  agentId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  result?: string;
  error?: unknown;
  git?: { branches: GitBranch[] };
};

export type CreateAgentRequest = {
  prompt: Prompt;
  repos: RepositoryInput[];
  /** Always false in Outpost phase 1. */
  autoCreatePR: false;
  name?: string;
  model?: ModelRef;
};

export type CreateAgentResponse = {
  agent: Agent;
  run: Run;
};

export type CreateRunRequest = {
  prompt: Prompt;
  model?: ModelRef;
};

export type CreateRunResponse = {
  run: Run;
};

export type ListResult<T> = {
  items: T[];
  nextCursor?: string;
};

export type ToolCallStatus = "running" | "completed";

export type StreamEvent =
  | { type: "status"; id?: string; data: { runId: string; status: RunStatus } }
  | { type: "assistant"; id?: string; data: { text: string } }
  | { type: "thinking"; id?: string; data: { text: string } }
  | {
      type: "tool_call";
      id?: string;
      data: {
        callId: string;
        name: string;
        status: ToolCallStatus;
        args?: unknown;
        result?: unknown;
        truncated?: { args?: true; result?: true };
      };
    }
  | {
      type: "result";
      id?: string;
      data: {
        runId: string;
        status: RunStatus;
        text?: string;
        durationMs?: number;
        git?: { branches: GitBranch[] };
      };
    }
  | { type: "error"; id?: string; data: { code: string; message: string } }
  | { type: "done"; id?: string; data: Record<string, never> }
  | { type: "heartbeat"; id?: string; data: Record<string, unknown> }
  | { type: "unknown"; id?: string; event: string; data: unknown };

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export type ConversationMessage = {
  id: string;
  type: "user_message" | "assistant_message" | string;
  text: string;
  /** Present when Cursor API exposes user prompt images (not yet on v0 conversation). */
  images?: PromptImage[];
};

export type Conversation = {
  id: string;
  messages: ConversationMessage[];
};

