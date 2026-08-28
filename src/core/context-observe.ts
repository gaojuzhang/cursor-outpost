/** Heuristics for context-window observability (usage stream + compaction hints). */

export type ObservedTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

/** Approximate model context limit when API does not expose headroom. */
export const DEFAULT_CONTEXT_TOKEN_LIMIT = 128_000;

/** Warn once per run when estimated context exceeds this ratio. */
export const CONTEXT_WARN_RATIO = 0.8;

const COMPACTION_HINT =
  /summariz|compress|compaction|context.*(full|limit|window)/i;

export function normalizeObservedUsage(
  usage: ObservedTokenUsage | undefined | null,
): ObservedTokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const totalTokens =
    usage.totalTokens ??
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalTokens <= 0 && inputTokens + cacheReadTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

/** Best-effort: tokens read into the model context this turn. */
export function estimateContextTokens(usage: ObservedTokenUsage): number {
  const fromFields = usage.inputTokens + usage.cacheReadTokens;
  if (fromFields > 0) return fromFields;
  return usage.totalTokens;
}

export function contextUsagePct(
  tokens: number,
  limit = DEFAULT_CONTEXT_TOKEN_LIMIT,
): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((tokens / limit) * 100));
}

export function shouldWarnNearFull(
  tokens: number,
  limit = DEFAULT_CONTEXT_TOKEN_LIMIT,
  ratio = CONTEXT_WARN_RATIO,
): boolean {
  return tokens >= limit * ratio;
}

export function isCompactionHint(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  return COMPACTION_HINT.test(text);
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 10_000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}
