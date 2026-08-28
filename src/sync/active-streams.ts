/** Tracks which agent/run this process is currently SSE-streaming. */
export class ActiveStreamTracker {
  private readonly map = new Map<string, string>();

  set(agentId: string, runId: string): void {
    this.map.set(agentId, runId);
  }

  /** Clear only if still the same run. */
  clear(agentId: string, runId: string): void {
    if (this.map.get(agentId) === runId) {
      this.map.delete(agentId);
    }
  }

  get(agentId: string): string | undefined {
    return this.map.get(agentId);
  }

  isStreaming(agentId: string, runId: string): boolean {
    return this.map.get(agentId) === runId;
  }
}
