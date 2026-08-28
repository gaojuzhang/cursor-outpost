/** Map @cursor/sdk types to Outpost REST-shaped types. */

import type { Run as SdkRun, RunStatus as SdkRunStatus } from "@cursor/sdk";
import type { SDKMessage } from "@cursor/sdk";
import type { SDKAgentInfo } from "@cursor/sdk";
import type { Agent, GitBranch, Run, RunStatus, StreamEvent } from "./types.js";

export const CURSOR_AGENT_URL_PREFIX = "https://cursor.com/agents/";

export function agentUrl(agentId: string): string {
  return `${CURSOR_AGENT_URL_PREFIX}${agentId}`;
}

export function mapSdkRunStatus(status: string | SdkRunStatus): RunStatus {
  const s = status.toUpperCase();
  if (s === "CREATING") return "CREATING";
  if (s === "RUNNING") return "RUNNING";
  if (s === "FINISHED") return "FINISHED";
  if (s === "ERROR") return "ERROR";
  if (s === "CANCELLED") return "CANCELLED";
  if (s === "EXPIRED") return "EXPIRED";
  // SDK Run.status uses lowercase
  if (status === "running") return "RUNNING";
  if (status === "finished") return "FINISHED";
  if (status === "error") return "ERROR";
  if (status === "cancelled") return "CANCELLED";
  return "RUNNING";
}

function isoFromMs(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

export function mapSdkRun(run: SdkRun): Run {
  const status = mapSdkRunStatus(run.status);
  return {
    id: run.id,
    agentId: run.agentId,
    status,
    createdAt: isoFromMs(run.createdAt),
    updatedAt: isoFromMs(run.createdAt),
    durationMs: run.durationMs,
    result: run.result,
    git: run.git
      ? {
          branches: run.git.branches.map((b) => ({
            repoUrl: b.repoUrl,
            branch: b.branch,
            prUrl: b.prUrl,
          })),
        }
      : undefined,
  };
}

export function mapSdkAgentInfo(info: SDKAgentInfo): Agent {
  const archived = info.archived === true;
  return {
    id: info.agentId,
    name: info.name,
    status: archived ? "ARCHIVED" : "ACTIVE",
    url: agentUrl(info.agentId),
    createdAt: isoFromMs(info.createdAt),
    updatedAt: isoFromMs(info.lastModified),
  };
}

export function mapSdkMessage(msg: SDKMessage): StreamEvent | undefined {
  switch (msg.type) {
    case "status":
      return {
        type: "status",
        data: {
          runId: msg.run_id,
          status: mapSdkRunStatus(msg.status),
        },
      };
    case "assistant": {
      const text = msg.message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { type: "assistant", data: { text } };
    }
    case "thinking":
      return { type: "thinking", data: { text: msg.text } };
    case "tool_call":
      return {
        type: "tool_call",
        data: {
          callId: msg.call_id,
          name: msg.name,
          status: msg.status === "running" ? "running" : "completed",
          args: msg.args,
          result: msg.result,
          truncated: msg.truncated
            ? {
                args: msg.truncated.args ? true : undefined,
                result: msg.truncated.result ? true : undefined,
              }
            : undefined,
        },
      };
    case "system":
    case "user":
    case "request":
    case "task":
    case "usage":
      return undefined;
    default:
      return undefined;
  }
}

export function resultEventFromRun(run: SdkRun): StreamEvent {
  const status = mapSdkRunStatus(run.status);
  return {
    type: "result",
    data: {
      runId: run.id,
      status,
      text: run.result,
      durationMs: run.durationMs,
      git: run.git as Run["git"],
    },
  };
}

export function gitBranches(run: SdkRun): GitBranch[] {
  return (
    run.git?.branches?.map((b) => ({
      repoUrl: b.repoUrl,
      branch: b.branch,
      prUrl: b.prUrl,
    })) ?? []
  );
}
