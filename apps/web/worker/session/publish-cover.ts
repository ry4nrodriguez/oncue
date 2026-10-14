// Which run's checks cover the code a publish would push (record 14). A Done
// run changed nothing, so the walk back from the publishing run skips it; the
// first other outcome decides. `unchecked` asks for a checks-only run first and
// `held` pushes nothing. A checks-only run ending Done is not believed (it
// always verifies). A cancelled run is `unchecked`, because a change may have
// been cut off before its checks; a cancelled checks-only run is `held` so
// stopped checks are not rerun.

export interface RunForCover {
  readonly id: string;
  readonly outcome: string | null;
  readonly trigger: string;
}

export type CoverDecision =
  | {
      readonly kind: "covered";
      readonly runId: string;
      readonly outcome: "verified" | "completed_with_warnings";
    }
  | { readonly kind: "unchecked" }
  | { readonly kind: "held" };

/** `runs` newest first, starting with the run that asked for the publish. */
export function coverFor(runs: readonly RunForCover[]): CoverDecision {
  for (const run of runs) {
    switch (run.outcome) {
      case "completed":
        if (run.trigger === "checks_requested") {
          return { kind: "held" };
        }
        continue;
      case "verified":
      case "completed_with_warnings":
        return { kind: "covered", runId: run.id, outcome: run.outcome };
      case "cancelled":
        return run.trigger === "checks_requested" ? { kind: "held" } : { kind: "unchecked" };
      default:
        return { kind: "held" };
    }
  }
  return { kind: "unchecked" };
}

/** The run the verification section cites: the covering run, else `fallback`. */
export function evidenceRunFor(runs: readonly RunForCover[], fallback: string): string {
  const cover = coverFor(runs);
  return cover.kind === "covered" ? cover.runId : fallback;
}

/** The instruction text of a checks-only run started before a publish. */
export const CHECKS_BEFORE_PUBLISH_TEXT = "Check the code before pushing it.";
