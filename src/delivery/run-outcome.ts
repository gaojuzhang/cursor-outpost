import type { ObservedTokenUsage } from "../core/context-observe.js";
import type { Run, RunStatus } from "../cursor/types.js";

export type RunBodySource =
  | "stream"
  | "run"
  | "run_conversation"
  | "conversation"
  | "none";

/** Canonical delivery record for one cloud run → IM. */
export type RunOutcome = {
  body: string;
  bodySource: RunBodySource;
  runStatus?: RunStatus;
  git?: Run["git"];
  usage?: ObservedTokenUsage;
  compacted?: boolean;
};

export function prUrlsFromGit(git: Run["git"] | undefined): string[] {
  return (
    git?.branches
      ?.map((b) => b.prUrl)
      .filter((u): u is string => Boolean(u)) ?? []
  );
}
