import type { ChannelId, IncomingImage, OutgoingTarget } from "../channels/types.js";

export type QueuedPrompt = {
  text: string;
  target: OutgoingTarget;
  channel: ChannelId;
  images?: IncomingImage[];
};

/** Per-agent FIFO of follow-up prompts (in-memory). */
export class AgentQueue {
  private readonly queues = new Map<string, QueuedPrompt[]>();

  enqueue(agentId: string, item: QueuedPrompt): number {
    const list = this.queues.get(agentId) ?? [];
    list.push(item);
    this.queues.set(agentId, list);
    return list.length;
  }

  dequeue(agentId: string): QueuedPrompt | undefined {
    const list = this.queues.get(agentId);
    if (!list || list.length === 0) return undefined;
    const item = list.shift()!;
    if (list.length === 0) this.queues.delete(agentId);
    else this.queues.set(agentId, list);
    return item;
  }

  size(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /** Drop all pending items; returns how many were cleared. */
  clear(agentId: string): number {
    const n = this.size(agentId);
    this.queues.delete(agentId);
    return n;
  }
}
