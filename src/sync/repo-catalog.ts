import { slugFromRepoUrl } from "../core/repo-url.js";
import type { CursorClient } from "../cursor/client.js";
import { DEFAULT_REPO_REF } from "../store/db.js";

export type RepoCatalogDeps = {
  cursor: CursorClient;
  intervalMs?: number;
};

export type CursorRepo = { url: string };

export class RepoCatalog {
  private readonly cursor: CursorClient;
  private readonly intervalMs: number;
  private repos: CursorRepo[] | null = null;
  private loadedAt = 0;

  constructor(deps: RepoCatalogDeps) {
    this.cursor = deps.cursor;
    this.intervalMs = deps.intervalMs ?? 180_000;
  }

  async list(force = false): Promise<CursorRepo[]> {
    if (
      !force &&
      this.repos &&
      Date.now() - this.loadedAt < this.intervalMs
    ) {
      return this.repos;
    }
    this.repos = await this.cursor.listRepositories();
    this.loadedAt = Date.now();
    return this.repos;
  }

  syncToStore(
    store: import("../store/db.js").Store,
    repos?: CursorRepo[],
  ): void {
    const list = repos ?? this.repos ?? [];
    store.upsertCursorRepos(
      list.map((r) => ({
        slug: slugFromRepoUrl(r.url),
        repoUrl: r.url,
        ref: DEFAULT_REPO_REF,
      })),
    );
  }

  lastLoadedAt(): number | null {
    return this.loadedAt > 0 ? this.loadedAt : null;
  }

  slug(url: string): string {
    return slugFromRepoUrl(url);
  }

  resolveToken(token: string, repos: CursorRepo[]): CursorRepo | undefined {
    const raw = token.trim();
    if (!raw) return undefined;
    if (/^\d+$/.test(raw)) {
      const idx = Number.parseInt(raw, 10);
      if (idx < 1 || idx > repos.length) return undefined;
      return repos[idx - 1];
    }
    const lower = raw.toLowerCase();
    const norm = normalizeRepoUrlForMatch(raw);
    return repos.find((r) => {
      const slug = slugFromRepoUrl(r.url).toLowerCase();
      return (
        slug === lower ||
        r.url.toLowerCase() === lower ||
        normalizeRepoUrlForMatch(r.url) === norm ||
        normalizeRepoUrlForMatch(r.url).endsWith(`/${lower}`)
      );
    });
  }
}

function normalizeRepoUrlForMatch(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}
