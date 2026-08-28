/** Normalize repo URLs for matching (https://github.com/org/repo ≡ github.com/org/repo). */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function repoUrlMatches(agentRepo: string, projectRepoUrl: string): boolean {
  return normalizeRepoUrl(agentRepo) === normalizeRepoUrl(projectRepoUrl);
}

/** Short label from `https://github.com/org/repo` → `repo`. */
export function slugFromRepoUrl(url: string): string {
  const norm = url.trim().replace(/\/$/, "").replace(/\.git$/i, "");
  const segment = norm.split("/").pop();
  return segment && segment.length > 0 ? segment : norm;
}
