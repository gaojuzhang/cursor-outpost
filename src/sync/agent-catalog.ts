import type { CursorClient } from "../cursor/client.js";
import {
  agentDisplayLabel,
  isGenericAgentName,
  labelFromConversationText,
} from "../core/agent-label.js";
import { repoUrlMatches } from "../core/repo-url.js";
import type { CachedAgentRow, Store } from "../store/db.js";

export type AgentCatalogDeps = {
  store: Store;
  cursor: CursorClient;
  intervalMs: number;
};

export class AgentCatalog {
  private readonly store: Store;
  private readonly cursor: CursorClient;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;

  constructor(deps: AgentCatalogDeps) {
    this.store = deps.store;
    this.cursor = deps.cursor;
    this.intervalMs = deps.intervalMs;
  }

  start(): void {
    if (this.timer) return;
    console.log(
      `outpost: agent catalog auto-refresh (interval=${this.intervalMs}ms)`,
    );
    this.timer = setInterval(() => {
      void this.refresh(false);
    }, this.intervalMs);
    void this.refresh(false);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Pull cloud agent list from SDK into local cache.
   * @returns number of agents upserted, or -1 if skipped (fresh cache).
   */
  async refresh(force: boolean): Promise<number> {
    if (this.refreshing) return 0;
    const last = this.store.getAgentCacheLastSyncedAt();
    if (
      !force &&
      last != null &&
      Date.now() - last < this.intervalMs
    ) {
      return -1;
    }

    this.refreshing = true;
    try {
      const items = await this.cursor.fetchAllCloudAgents({
        includeArchived: true,
      });
      this.store.upsertAgentCache(items);
      console.log(`outpost: agent catalog refreshed (${items.length} agents)`);
      return items.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`outpost: agent catalog refresh failed: ${msg}`);
      throw err;
    } finally {
      this.refreshing = false;
    }
  }

  listForProject(
    projectRepoUrl: string | undefined,
    limit = 20,
  ): CachedAgentRow[] {
    const all = this.store.listCachedAgents(limit * 3, true);
    if (!projectRepoUrl) return all.slice(0, limit);
    const matched = all.filter((row) => {
      if (!row.repos_json) return false;
      try {
        const repos = JSON.parse(row.repos_json) as string[];
        return repos.some((r) => repoUrlMatches(r, projectRepoUrl));
      } catch {
        return false;
      }
    });
    return matched.slice(0, limit);
  }

  findInProject(
    projectRepoUrl: string | undefined,
    token: string,
  ): CachedAgentRow | undefined {
    const list = this.listForProject(projectRepoUrl, 50);
    if (/^\d+$/.test(token)) {
      const idx = Number.parseInt(token, 10);
      if (idx < 1 || idx > list.length) return undefined;
      return list[idx - 1];
    }
    const lower = token.toLowerCase();
    return list.find(
      (a) =>
        a.agent_id.toLowerCase() === lower ||
        a.agent_id.toLowerCase().startsWith(lower),
    );
  }

  lastSyncedAt(): number | null {
    return this.store.getAgentCacheLastSyncedAt();
  }

  /**
   * For agents with Cursor's generic title, fetch first user prompt from v0 conversation.
   */
  async enrichDisplayNames(rows: CachedAgentRow[]): Promise<CachedAgentRow[]> {
    const out: CachedAgentRow[] = [];
    for (const row of rows) {
      if (row.display_name?.trim()) {
        out.push(row);
        continue;
      }
      if (!isGenericAgentName(row.name)) {
        out.push(row);
        continue;
      }
      try {
        const conv = await this.cursor.getConversation(row.agent_id);
        const firstUser = conv.messages.find((m) => m.type === "user_message");
        const label = labelFromConversationText(firstUser?.text ?? "");
        if (label) {
          this.store.setAgentDisplayName(row.agent_id, label);
          out.push({ ...row, display_name: label });
          continue;
        }
      } catch {
        /* deleted or unavailable */
      }
      out.push(row);
    }
    return out;
  }

  /** Fill missing run status (list cache may be stale or list API omitted status). */
  async enrichStatuses(rows: CachedAgentRow[]): Promise<CachedAgentRow[]> {
    const out: CachedAgentRow[] = [];
    for (const row of rows) {
      if (row.status?.trim() || row.archived !== 0) {
        out.push(row);
        continue;
      }
      try {
        const status = await this.cursor.getAgentSdkStatus(row.agent_id);
        if (status?.trim()) {
          this.store.updateAgentCacheStatus(row.agent_id, status);
          out.push({ ...row, status });
          continue;
        }
      } catch {
        /* deleted or unavailable */
      }
      out.push(row);
    }
    return out;
  }

  displayLabel(row: CachedAgentRow): string {
    return agentDisplayLabel(row.name, row.summary, row.display_name);
  }
}
