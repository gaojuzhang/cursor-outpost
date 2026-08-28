import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectConfig } from "../config.js";

export type ProjectRow = {
  slug: string;
  repo_url: string;
  ref: string;
};

export type ThreadRow = {
  channel: string;
  chat_id: string;
  thread_id: string;
  slug: string | null;
  agent_id: string | null;
  agent_url: string | null;
  status: string;
  verbose: number | null;
};

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

  getActiveThread(
    channel: string,
    chatId: string,
    threadId: string,
  ): ThreadRow | undefined {
    return this.db
      .prepare(
        `SELECT channel, chat_id, thread_id, slug, agent_id, agent_url, status, verbose
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
        `SELECT channel, chat_id, thread_id, slug, agent_id, agent_url, status, verbose
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

  /** /new: clear agent mapping; keep slug + verbose. */
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
   * /bind: attach slug to this chat/thread.
   * Rebinding to a different slug clears agent_id/url.
   * Returns previous agent_id if cleared (for queue cleanup).
   */
  bindThread(
    channel: string,
    chatId: string,
    threadId: string,
    slug: string,
  ): { previousAgentId: string | null } {
    const row = this.db
      .prepare(
        `SELECT slug, agent_id FROM threads
         WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
      )
      .get(channel, chatId, threadId) as
      | { slug: string | null; agent_id: string | null }
      | undefined;

    let previousAgentId: string | null = null;
    const slugChanged = row != null && row.slug != null && row.slug !== slug;
    if (slugChanged && row?.agent_id) {
      previousAgentId = row.agent_id;
    }

    if (!row) {
      this.db
        .prepare(
          `INSERT INTO threads (channel, chat_id, thread_id, slug, status)
           VALUES (?, ?, ?, ?, 'active')`,
        )
        .run(channel, chatId, threadId, slug);
    } else if (slugChanged) {
      this.db
        .prepare(
          `UPDATE threads
           SET slug = ?, agent_id = NULL, agent_url = NULL, status = 'active'
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(slug, channel, chatId, threadId);
    } else {
      this.db
        .prepare(
          `UPDATE threads
           SET slug = ?, status = 'active'
           WHERE channel = ? AND chat_id = ? AND thread_id = ?`,
        )
        .run(slug, channel, chatId, threadId);
    }

    return { previousAgentId };
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
  addOutboundPrompt(agentId: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO outbound_prompts (agent_id, text, created_at, consumed)
         VALUES (?, ?, ?, 0)`,
      )
      .run(agentId, text, new Date().toISOString());
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

  hasConversationMessage(messageId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM conversation_msgs WHERE message_id = ?")
      .get(messageId) as { ok: number } | undefined;
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
        `SELECT channel, chat_id, thread_id, slug, agent_id, agent_url, status, verbose
         FROM threads
         WHERE status = 'active' AND agent_id IS NOT NULL AND agent_id != ''`,
      )
      .all() as ThreadRow[];
  }

  close(): void {
    this.db.close();
  }
}
