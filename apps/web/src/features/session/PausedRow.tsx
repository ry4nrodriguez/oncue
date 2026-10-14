/**
 * The timeline row for a run paused on a model failure (record 15). It stands
 * on the timeline like an outcome, since nothing more happens until the
 * person acts, and names the failure where they are reading.
 */
import type { SessionView, TimelineItem } from "@oncue/protocol";
import { ModelConnectionsLink } from "./ContextRail";
import { type ModelFailure, modelFailureSentence } from "./model-failure";

type RunItem = Extract<TimelineItem, { kind: "run" }>;

/** The failure a pause row is about, or null for any other row. */
export function modelFailureOfRow(item: TimelineItem): ModelFailure | null {
  if (item.kind !== "run" || item.pause?.reason !== "model_failure") {
    return null;
  }
  return item.pause.modelFailure ?? null;
}

/**
 * Whether this row is the pause its run is stopped on now. An earlier pause,
 * or one the run has since resumed from, is history and offers nothing to do.
 */
export function isOpenPause(view: SessionView, item: RunItem): boolean {
  if (view.runs.get(item.runId)?.state !== "paused") {
    return false;
  }
  for (let index = view.timeline.length - 1; index >= 0; index -= 1) {
    const other = view.timeline[index];
    if (other?.kind === "run" && other.runId === item.runId && other.transition === "paused") {
      return other.sequence === item.sequence;
    }
  }
  return false;
}

export function PausedRow({
  view,
  item,
  failure,
  linksToKeys,
}: {
  view: SessionView;
  item: RunItem;
  failure: ModelFailure;
  /**
   * Whether the way forward is in Settings, Model providers, as the screen
   * that knows the key's state decides it. Absent, a rejected key links.
   */
  linksToKeys?: boolean | undefined;
}) {
  // Only the pause the run is stopped on has anything left to do.
  const showsLink =
    isOpenPause(view, item) && (linksToKeys ?? failure.category === "authentication_failed");
  return (
    <div
      data-testid="row-run"
      data-transition="paused"
      data-category={failure.category}
      className="py-1.5 pl-1 text-[13px]"
    >
      <span className="font-medium text-caution">Paused</span>
      <div className="mt-0.5 text-[12px] text-muted-foreground">
        <p className="whitespace-pre-wrap break-words" data-testid="pause-reason">
          {modelFailureSentence(failure)}
        </p>
        {showsLink ? <ModelConnectionsLink /> : null}
      </div>
    </div>
  );
}
