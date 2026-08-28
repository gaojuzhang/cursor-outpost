import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectConfig } from "../config.js";
import { slugFromRepoUrl } from "../core/repo-url.js";

export type ProjectRow = {
  slug: string;
  repo_url: string;
  ref: string;
};

export type CachedAgentRow = {
  agent_id: string;
  name: string;
  summary: string;
  display_name: string | null;
  status: string | null;
  archived: number;
  repos_json: string | null;
  last_modified: number;
  synced_at: string;
};

export type ThreadRow = {
  channel: string;
  chat_id: string;
  thread_id: string;
  slug: string | null;
  repo_url: string | null;
  repo_ref: string | null;
  agent_id: string | null;
  agent_url: string | null;
  status: string;
  verbose: number | null;
  model_id: string | null;
};

export type ThreadBinding = {
  slug: string;
  repo_url: string;
  ref: string;
};

export type CursorRepoRow = {
  slug: string;
  repo_url: string;
  ref: string;
  synced_at: string;
};

export const DEFAULT_REPO_REF = "main";

/**
 * SQLite store. Projects are synced from config.yaml on startup;
 * the DB is the runtime source of truth for threads/runs/allowlist.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        slug TEXT PRIMARY KEY NOT NULL,
        repo_url TEXT NOT NULL,
        ref TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        slug TEXT,
        agent_id TEXT,
        agent_url TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        verbose INTEGER,
        PRIMARY KEY (channel, chat_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        channel TEXT NOT NULL,
        created_at TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS allowlist (
        channel TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        PRIMARY KEY (channel, sender_id)
      );

      CREATE TABLE IF NOT EXISTS outbound_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS conversation_msgs (
        message_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0
      );
    `);

    const runCols = this.db
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    if (!runCols.some((c) => c.name === "notified")) {
      this.db.exec(
        "ALTER TABLE runs ADD COLUMN notified INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.migrateConversationMsgsCompositeKey();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_cache (
        agent_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        display_name TEXT,
        status TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        repos_json TEXT,
        last_modified INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL
      );
    `);
    const agentCacheCols = this.db
      .prepare("PRAGMA table_info(agent_cache)")
      .all() as Array<{ name: string }>;
    if (!agentCacheCols.some((c) => c.name === "display_name")) {
      this.db.exec("ALTER TABLE agent_cache ADD COLUMN display_name TEXT");
    }
    const threadCols = this.db
      .prepare("PRAGMA table_info(threads)")
      .all() as Array<{ name: string }>;
    if (!threadCols.some((c) => c.name === "model_id")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN model_id TEXT");
    }
    const threadCols2 = this.db
      .prepare("PRAGMA table_info(threads)")
      .all() as Array<{ name: string }>;
    if (!threadCols2.some((c) => c.name === "repo_url")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN repo_url TEXT");
    }
    if (!threadCols2.some((c) => c.name === "repo_ref")) {
      this.db.exec("ALTER TABLE threads ADD COLUMN repo_ref TEXT");
    }
    const outboundCols = this.db
      .prepare("PRAGMA table_info(outbound_prompts)")
      .all() as Array<{ name: string }>;
    if (!outboundCols.some((c) => c.name === "run_id")) {
      this.db.exec("ALTER TABLE outbound_prompts ADD COLUMN run_id TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursor_repos (
        slug TEXT PRIMARY KEY NOT NULL,
        repo_url TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT 'main',
        synced_at TEXT NOT NULL
      );
    `);
    this.backfillThreadReposFromProjects();
  }

  /** Legacy threads: slug from config projects → repo_url on thread row. */
  private backfillThreadReposFromProjects(): void {
    this.db.exec(`
      UPDATE threads
      SET repo_url = (
        SELECT repo_url FROM projects WHERE projects.slug = threads.slug
      ),
      repo_ref = (
        SELECT ref FROM projects WHERE projects.slug = threads.slug
      )
      WHERE repo_url IS NULL AND slug IS NOT NULL
        AND EXISTS (SELECT 1 FROM projects WHERE projects.slug = threads.slug);
    `);
  }

  /** message_id alone collides across agents (turn-1:user); use (message_id, agent_id). */
  private migrateConversationMsgsCompositeKey(): void {
    const row = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_msgs'",
      )
      .get() as { sql: string } | undefined;
    if (!row?.sql || row.sql.includes("message_id, agent_id")) return;

    this.db.exec(`
      CREATE TABLE conversation_msgs_v2 (
        message_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, agent_id)
      );
      INSERT OR IGNORE INTO conversation_msgs_v2
        SELECT message_id, agent_id, kind, notified FROM conversation_msgs;
      DROP TABLE conversation_msgs;
      ALTER TABLE conversation_msgs_v2 RENAME TO conversation_msgs;
    `);
  }

  /** Upsert yaml projects; remove slugs no longer in yaml. */
  syncProjectsFromConfig(projects: ProjectConfig[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO projects (slug, repo_url, ref)
      VALUES (?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        repo_url = excluded.repo_url,
        ref = excluded.ref
    `);
    const listSlugs = this.db.prepare("SELECT slug FROM projects");
    const del = this.db.prepare("DELETE FROM projects WHERE slug = ?");
    const keep = new Set(projects.map((p) => p.slug));

    this.db.exec("BEGIN");
    try {
      for (const p of projects) {
        upsert.run(p.slug, p.repo_url, p.ref);
      }
      for (const row of listSlugs.all() as Array<{ slug: string }>) {
        if (!keep.has(row.slug)) {
          del.run(row.slug);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listProjects(): ProjectRow[] {
    return this.db
      .prepare("SELECT slug, repo_url, ref FROM projects ORDER BY slug")
      .all() as ProjectRow[];
  }

  getProject(slug: string): ProjectRow | undefined {
    const row = this.db
      .prepare("SELECT slug, repo_url, ref FROM projects WHERE slug = ?")
      .get(slug) as ProjectRow | undefined;
    return row;
  }

  upsertCursorRepos(
    items: Array<{ slug: string; repoUrl: string; ref?: string }>,
  ): void {
    const syncedAt = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO cursor_repos (slug, repo_url, ref, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        repo_url = excluded.repo_url,
        synced_at = excluded.synced_at
    `);
    for (const item of items) {
      upsert.run(
        item.slug,
        item.repoUrl,
        item.ref ?? DEFAULT_REPO_REF,
        syncedAt,
      );
    }
  }

  getCursorRepo(slug: string): ThreadBinding | undefined {
    const row = this.db
      .prepare("SELECT slug, repo_url, ref FROM cursor_repos WHERE slug = ?")
      .get(slug) as CursorRepoRow | undefined;
    if (!row) return undefined;
    return { slug: row.slug, repo_url: row.repo_url, ref: row.ref };
  }

  listCursorRepos(): CursorRepoRow[] {
    return this.db
      .prepare(
        "SELECT slug, repo_url, ref, synced_at FROM cursor_repos ORDER BY slug",
      )
      .all() as CursorRepoRow[];
  }

  resolveThreadBinding(thread: ThreadRow | undefined): ThreadBinding | undefined {
    if (!thread) return undefined;
    if (thread.repo_url) {
      return {
        slug: thread.slug ?? slugFromRepoUrl(thread.repo_url),
        repo_url: thread.repo_url,
        ref: thread.repo_ref ?? DEFAULT_REPO_REF,
      };
    }
    if (thread.slug) {
      const cached = this.getCursorRepo(thread.slug);
      if (cached) return cached;
      const legacy = this.getProject(thread.slug);
      if (legacy) {
        return {
          slug: legacy.slug,
          repo_url: legacy.repo_url,
          ref: legacy.ref,
        };
      }
    }
    return undefined;
  }

  /** Replace allowlist for a channel from env-derived ids. */
  syncAllowlist(channel: string, senderIds: string[]): void {
    const del = this.db.prepare("DELETE FROM allowlist WHERE channel = ?");
    const ins = this.db.prepare(
      "INSERT INTO allowlist (channel, sender_id) VALUES (?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      del.run(channel);
      for (const id of senderIds) {
        ins.run(channel, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  isAllowed(channel: string, senderId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS ok FROM allowlist WHERE channel = ? AND sender_id = ?",
      )
      .get(channel, senderId) as { ok: number } | undefined;
    return row != null;
  }

  /**
   * Effective verbose: thread override (0/1) or null → use globalDefault.
   */
  resolveVerbose(
    channel: string,
    chatId: string,
    threadId: string,
    globalDefault: boolean,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT verbose FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ? AND status = 'active'`,
      )
      .get(channel, chatId, threadId) as { verbose: number | null } | undefined;
    if (!row || row.verbose == null) return globalDefault;
    return row.verbose === 1;
  }

  setThreadVerbose(
    channel: string,
    chatId: string,
    threadId: string,
    verbose: boolean,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT channel FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(channel, chatId, threadId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE threads SET verbose = ?, status = 'active'
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(verbose ? 1 : 0, channel, chatId, threadId);
    } else {
      this.db
        .prepare(
          `INSERT INTO threads (channel, chat_id, thread_id, status, verbose)
           VALUES (?, ?, ?, 'active', ?)`,
        )
        .run(channel, chatId, threadId, verbose ? 1 : 0);
    }
  }

  /**
   * Per-thread model preference. `null` or `default` = Auto.
   */
  resolveModelId(
    channel: string,
    chatId: string,
    threadId: string,
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT model_id FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ? AND status = 'active'`,
      )
      .get(channel, chatId, threadId) as { model_id: string | null } | undefined;
    if (!row?.model_id) return null;
    return row.model_id;
  }

  setThreadModel(
    channel: string,
    chatId: string,
    threadId: string,
    modelId: string | null,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT channel FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(channel, chatId, threadId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE threads SET model_id = ?, status = 'active'
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(modelId, channel, chatId, threadId);
    } else {
      this.db
        .prepare(
          `INSERT INTO threads (channel, chat_id, thread_id, status, model_id)
           VALUES (?, ?, ?, 'active', ?)`,
        )
        .run(channel, chatId, threadId, modelId);
    }
  }

  getActiveThread(
    channel: string,
    chatId: string,
    threadId: string,
  ): ThreadRow | undefined {
    return this.db
      .prepare(
        `SELECT channel, chat_id, thread_id, slug, repo_url, repo_ref, agent_id, agent_url, status, verbose, model_id
         FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ? AND status = 'active'`,
      )
      .get(channel, chatId, threadId) as ThreadRow | undefined;
  }

  /** Ensure active thread row exists; set slug if provided and currently null. */
  ensureActiveThread(
    channel: string,
    chatId: string,
    threadId: string,
    slug: string,
  ): ThreadRow {
    const row = this.db
      .prepare(
        `SELECT channel, chat_id, thread_id, slug, repo_url, repo_ref, agent_id, agent_url, status, verbose, model_id
         FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(channel, chatId, threadId) as ThreadRow | undefined;

    if (!row) {
      this.db
        .prepare(
          `INSERT INTO threads (channel, chat_id, thread_id, slug, status)
           VALUES (?, ?, ?, ?, 'active')`,
        )
        .run(channel, chatId, threadId, slug);
    } else if (row.status !== "active") {
      this.db
        .prepare(
          `UPDATE threads
           SET status = 'active', slug = COALESCE(slug, ?), agent_id = NULL, agent_url = NULL
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(slug, channel, chatId, threadId);
    } else if (!row.slug) {
      this.db
        .prepare(
          `UPDATE threads SET slug = ?
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(slug, channel, chatId, threadId);
    }

    return this.getActiveThread(channel, chatId, threadId)!;
  }

  setThreadAgent(
    channel: string,
    chatId: string,
    threadId: string,
    agentId: string,
    agentUrl: string,
  ): void {
    this.db
      .prepare(
        `UPDATE threads
         SET agent_id = ?, agent_url = ?, status = 'active'
         WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
      )
      .run(agentId, agentUrl, channel, chatId, threadId);
  }

  /** /new: clear agent mapping; keep slug + verbose + model. */
  resetThreadAgent(
    channel: string,
    chatId: string,
    threadId: string,
  ): void {
    this.db
      .prepare(
        `UPDATE threads
         SET agent_id = NULL, agent_url = NULL, status = 'active'
         WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
      )
      .run(channel, chatId, threadId);
  }

  /**
   * Drop per-agent echo/sync state so a new agent does not inherit
   * conversation message ids or outbound prompt fingerprints.
   */
  clearAgentSyncState(agentId: string): void {
    this.db
      .prepare("DELETE FROM conversation_msgs WHERE agent_id = ?")
      .run(agentId);
    this.db
      .prepare("DELETE FROM outbound_prompts WHERE agent_id = ?")
      .run(agentId);
    this.db.prepare("DELETE FROM runs WHERE agent_id = ?").run(agentId);
  }

  /**
   * /bind: attach repo to topic. Rebinding to a different repo clears agent_id/url.
   */
  bindThreadRepo(
    channel: string,
    chatId: string,
    threadId: string,
    binding: ThreadBinding,
  ): { previousAgentId: string | null } {
    const row = this.db
      .prepare(
        `SELECT slug, repo_url, agent_id FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(channel, chatId, threadId) as
      | { slug: string | null; repo_url: string | null; agent_id: string | null }
      | undefined;

    let previousAgentId: string | null = null;
    const repoChanged =
      row != null &&
      row.repo_url != null &&
      row.repo_url !== binding.repo_url;
    const slugOnlyChange =
      row != null &&
      row.repo_url == null &&
      row.slug != null &&
      row.slug !== binding.slug;
    if ((repoChanged || slugOnlyChange) && row?.agent_id) {
      previousAgentId = row.agent_id;
    }

    const bindingChanged = repoChanged || slugOnlyChange;

    if (!row) {
      this.db
        .prepare(
          `INSERT INTO threads (channel, chat_id, thread_id, slug, repo_url, repo_ref, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          channel,
          chatId,
          threadId,
          binding.slug,
          binding.repo_url,
          binding.ref,
        );
    } else if (bindingChanged) {
      this.db
        .prepare(
          `UPDATE threads
           SET slug = ?, repo_url = ?, repo_ref = ?,
               agent_id = NULL, agent_url = NULL, status = 'active'
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(
          binding.slug,
          binding.repo_url,
          binding.ref,
          channel,
          chatId,
          threadId,
        );
    } else {
      this.db
        .prepare(
          `UPDATE threads
           SET slug = ?, repo_url = ?, repo_ref = ?, status = 'active'
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(
          binding.slug,
          binding.repo_url,
          binding.ref,
          channel,
          chatId,
          threadId,
        );
    }

    return { previousAgentId };
  }

  /** @deprecated Use bindThreadRepo */
  bindThread(
    channel: string,
    chatId: string,
    threadId: string,
    slug: string,
  ): { previousAgentId: string | null } {
    const cached = this.getCursorRepo(slug);
    const legacy = this.getProject(slug);
    const binding: ThreadBinding = cached ?? {
      slug,
      repo_url: legacy?.repo_url ?? slug,
      ref: legacy?.ref ?? DEFAULT_REPO_REF,
    };
    return this.bindThreadRepo(channel, chatId, threadId, binding);
  }

  insertRun(input: {
    runId: string;
    agentId: string;
    origin: "telegram" | "window";
    channel: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (run_id, agent_id, origin, channel, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.agentId,
        input.origin,
        input.channel,
        new Date().toISOString(),
      );
  }

  hasRun(runId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM runs WHERE run_id = ?")
      .get(runId) as { ok: number } | undefined;
    return row != null;
  }

  getRunOrigin(runId: string): "telegram" | "window" | undefined {
    const row = this.db
      .prepare("SELECT origin FROM runs WHERE run_id = ?")
      .get(runId) as { origin: string } | undefined;
    if (row?.origin === "telegram" || row?.origin === "window") {
      return row.origin;
    }
    return undefined;
  }

  isRunNotified(runId: string): boolean {
    const row = this.db
      .prepare("SELECT notified FROM runs WHERE run_id = ?")
      .get(runId) as { notified: number } | undefined;
    return row != null && row.notified === 1;
  }

  markRunNotified(runId: string): void {
    this.db
      .prepare("UPDATE runs SET notified = 1 WHERE run_id = ?")
      .run(runId);
  }

  /** Record a prompt we sent via IM so Poller won't echo it back. */
  addOutboundPrompt(agentId: string, text: string, runId?: string): void {
    this.db
      .prepare(
        `INSERT INTO outbound_prompts (agent_id, text, created_at, consumed, run_id)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(agentId, text, new Date().toISOString(), runId ?? null);
  }

  /**
   * If this user_message text matches an unconsumed outbound prompt for the agent,
   * mark it consumed and return true (echo — do not push to IM).
   */
  consumeOutboundPrompt(agentId: string, text: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM outbound_prompts
         WHERE agent_id = ? AND consumed = 0 AND text = ?
         ORDER BY id ASC LIMIT 1`,
      )
      .get(agentId, text) as { id: number } | undefined;
    if (!row) return false;
    this.db
      .prepare("UPDATE outbound_prompts SET consumed = 1 WHERE id = ?")
      .run(row.id);
    return true;
  }

  hasConversationMessage(messageId: string, agentId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS ok FROM conversation_msgs WHERE message_id = ? AND agent_id = ?",
      )
      .get(messageId, agentId) as { ok: number } | undefined;
    return row != null;
  }

  hasAnyConversationMessage(agentId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS ok FROM conversation_msgs WHERE agent_id = ? LIMIT 1",
      )
      .get(agentId) as { ok: number } | undefined;
    return row != null;
  }

  markConversationMessage(
    messageId: string,
    agentId: string,
    kind: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_msgs (message_id, agent_id, kind, notified)
         VALUES (?, ?, ?, 1)`,
      )
      .run(messageId, agentId, kind);
  }

  listActiveThreadsWithAgent(): ThreadRow[] {
    return this.db
      .prepare(
        `SELECT channel, chat_id, thread_id, slug, repo_url, repo_ref, agent_id, agent_url, status, verbose, model_id
         FROM threads
         WHERE status = 'active' AND agent_id IS NOT NULL AND agent_id != ''`,
      )
      .all() as ThreadRow[];
  }

  upsertAgentCache(
    items: Array<{
      agentId: string;
      name: string;
      summary: string;
      status?: string;
      archived?: boolean;
      lastModified: number;
      repos?: string[];
      displayName?: string;
    }>,
  ): void {
    const syncedAt = new Date().toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO agent_cache (
        agent_id, name, summary, display_name, status, archived, repos_json, last_modified, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name = excluded.name,
        summary = excluded.summary,
        display_name = COALESCE(excluded.display_name, agent_cache.display_name),
        status = excluded.status,
        archived = excluded.archived,
        repos_json = excluded.repos_json,
        last_modified = excluded.last_modified,
        synced_at = excluded.synced_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        upsert.run(
          item.agentId,
          item.name,
          item.summary,
          item.displayName ?? null,
          item.status ?? null,
          item.archived ? 1 : 0,
          item.repos?.length ? JSON.stringify(item.repos) : null,
          item.lastModified,
          syncedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getAgentCacheLastSyncedAt(): number | null {
    const row = this.db
      .prepare("SELECT MAX(synced_at) AS t FROM agent_cache")
      .get() as { t: string | null } | undefined;
    if (!row?.t) return null;
    const ms = Date.parse(row.t);
    return Number.isFinite(ms) ? ms : null;
  }

  listCachedAgents(limit: number, includeArchived = false): CachedAgentRow[] {
    const sql = includeArchived
      ? `SELECT agent_id, name, summary, display_name, status, archived, repos_json, last_modified, synced_at
         FROM agent_cache ORDER BY last_modified DESC LIMIT ?`
      : `SELECT agent_id, name, summary, display_name, status, archived, repos_json, last_modified, synced_at
         FROM agent_cache WHERE archived = 0 ORDER BY last_modified DESC LIMIT ?`;
    return this.db.prepare(sql).all(limit) as CachedAgentRow[];
  }

  setAgentDisplayName(agentId: string, displayName: string): void {
    this.db
      .prepare(
        "UPDATE agent_cache SET display_name = ? WHERE agent_id = ?",
      )
      .run(displayName, agentId);
  }

  updateAgentCacheStatus(agentId: string, status: string): void {
    this.db
      .prepare("UPDATE agent_cache SET status = ? WHERE agent_id = ?")
      .run(status, agentId);
  }

  /** Prompt text for conversation body matching; prefers run_id when set. */
  getOutboundPromptText(agentId: string, runId?: string): string | undefined {
    if (runId) {
      const byRun = this.db
        .prepare(
          `SELECT text FROM outbound_prompts
           WHERE agent_id = ? AND run_id = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(agentId, runId) as { text: string } | undefined;
      if (byRun?.text?.trim()) return byRun.text.trim();
    }
    return this.getLatestOutboundPromptText(agentId);
  }

  /** Latest Telegram→agent prompt text (for conversation body resolution). */
  getLatestOutboundPromptText(agentId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT text FROM outbound_prompts
         WHERE agent_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(agentId) as { text: string } | undefined;
    return row?.text?.trim() || undefined;
  }

  close(): void {
    this.db.close();
  }
}
