/**
 * Groups the timeline into turns. A turn begins at a user message; runs of
 * tool calls, plan steps, and artifacts fold into closed groups where they
 * happened, and a run's checks form their own group. Answers, cards,
 * milestones, change cards, outcome rows, and a pause on a model failure stay
 * on the timeline, so a turn reads answer, files, checks, verdict. Folded rows stay mounted, so their
 * `data-testid`s still resolve.
 */
import {
  type MessageView,
  RUN_OUTCOMES,
  type RunId,
  type SessionView,
  type TimelineItem,
} from "@oncue/protocol";

/** What a group holds: the agent's work, or the checks a run ends with. */
export type ActivityPhase = "work" | "checks";

export type TimelineUnit =
  | { readonly kind: "item"; readonly key: string; readonly item: TimelineItem }
  | {
      readonly kind: "activity";
      readonly key: string;
      readonly phase: ActivityPhase;
      readonly items: readonly TimelineItem[];
    }
  /** The end of a turn the agent answered: its answer as markdown, to copy. */
  | { readonly kind: "copy"; readonly key: string; readonly text: string }
  /** A turn whose run the owner started on another model than the run before it. */
  | { readonly kind: "model_change"; readonly key: string; readonly runId: RunId };

/** A message's parts as markdown: text as it is, code fenced with its language. */
export function messageMarkdown(message: MessageView): string {
  return message.parts
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "code"
          ? `\`\`\`${part.language ?? ""}\n${part.code}\n\`\`\``
          : "",
    )
    .filter((chunk) => chunk.length > 0)
    .join("\n\n")
    .trim();
}

/** The kinds that are the agent's work rather than its answer or a milestone. */
const WORK: ReadonlySet<TimelineItem["kind"]> = new Set(["tool", "progress", "plan", "artifact"]);
/** The kinds that are a run's checks and its verdict. */
const CHECKS: ReadonlySet<TimelineItem["kind"]> = new Set(["check", "verification"]);

const RUN_OUTCOME_SET: ReadonlySet<string> = new Set(RUN_OUTCOMES);

/**
 * Which group an item belongs in. Run transitions join whatever is open; an
 * outcome stands on the timeline and closes the group before it, and so does
 * a pause on a model failure, which waits on the person and must not be
 * folded out of sight.
 */
export function phaseOf(item: TimelineItem, current: ActivityPhase | null): ActivityPhase | null {
  if (WORK.has(item.kind)) {
    return "work";
  }
  if (CHECKS.has(item.kind)) {
    return "checks";
  }
  if (item.kind === "run") {
    if (RUN_OUTCOME_SET.has(item.transition) || item.pause?.reason === "model_failure") {
      return null;
    }
    return current ?? "work";
  }
  return null;
}

/** The words received so far for a message still streaming; empty after a reconnect or before the first delta. */
function liveText(view: SessionView, messageId: MessageView["messageId"]): string {
  return (view.live.messages.get(messageId) ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function itemKey(item: TimelineItem): string {
  return `${item.kind}-${item.sequence}`;
}

export function groupTimeline(
  view: SessionView,
  items: readonly TimelineItem[],
): readonly TimelineUnit[] {
  const units: TimelineUnit[] = [];
  // The call that started a subagent stands on the timeline as that
  // subagent's row, never inside a group (record 13, "Agents").
  const agentCalls = new Set<string>();
  for (const agent of view.agents.values()) {
    if (agent.parentToolCallId !== null) {
      agentCalls.add(agent.parentToolCallId);
    }
  }
  let fold: {
    kind: "activity";
    key: string;
    phase: ActivityPhase;
    items: TimelineItem[];
  } | null = null;
  // The turn so far: the agent's messages in it, and the run they belong to.
  let answers: MessageView[] = [];
  let turnRun: RunId | null = null;
  let turnKey = "start";

  const endTurn = () => {
    const settled =
      answers.length > 0 &&
      answers.every((message) => !message.streaming) &&
      (turnRun === null || view.runs.get(turnRun)?.outcome != null);
    const text = settled
      ? answers
          .map(messageMarkdown)
          .filter((t) => t.length > 0)
          .join("\n\n")
      : "";
    if (text.length > 0) {
      units.push({ kind: "copy", key: `copy-${turnKey}`, text });
    }
    answers = [];
    turnRun = null;
  };

  for (const item of items) {
    if (item.kind === "message") {
      const message = view.messages.get(item.messageId);
      if (message?.role === "user") {
        // A new turn: the previous one gets its copy control.
        endTurn();
        fold = null;
        turnKey = String(item.sequence);
        units.push({ kind: "item", key: itemKey(item), item });
        // The change is marked where it happened, so a reader scrolling back
        // sees which turns ran on which model.
        const started = message.runId === null ? undefined : view.runs.get(message.runId);
        if (started?.trigger === "model_change" && started.model !== null) {
          units.push({ kind: "model_change", key: `model-${item.sequence}`, runId: started.runId });
        }
        continue;
      }
      if (message !== undefined) {
        // The runtime wraps most tool steps in empty messages. One with no text
        // yet is skipped, so it does not split the work into one-step groups.
        if (messageMarkdown(message).length === 0 && liveText(view, item.messageId).length === 0) {
          continue;
        }
        answers.push(message);
        turnRun ??= message.runId;
      }
    }
    if (item.kind === "tool" && agentCalls.has(item.toolCallId)) {
      fold = null;
      units.push({ kind: "item", key: itemKey(item), item });
      continue;
    }
    const phase = phaseOf(item, fold?.phase ?? null);
    if (phase !== null) {
      // A new group when nothing is open or the phase changes.
      if (fold === null || fold.phase !== phase) {
        fold = { kind: "activity", key: `activity-${item.sequence}`, phase, items: [] };
        units.push(fold);
      }
      fold.items.push(item);
      continue;
    }
    // Anything else is shown in place and closes the open group.
    fold = null;
    units.push({ kind: "item", key: itemKey(item), item });
  }
  endTurn();
  return units;
}

/** The run a fold belongs to: the first of its items that names one. */
export function runOfActivity(view: SessionView, items: readonly TimelineItem[]): RunId | null {
  for (const item of items) {
    switch (item.kind) {
      case "tool": {
        const runId = view.tools.get(item.toolCallId)?.runId;
        if (runId !== undefined) {
          return runId;
        }
        break;
      }
      case "check": {
        const runId = view.verification.checks.get(item.checkId)?.runId;
        if (runId !== undefined) {
          return runId;
        }
        break;
      }
      case "progress": {
        const runId = view.progress.get(item.stepId)?.runId;
        if (runId !== undefined) {
          return runId;
        }
        break;
      }
      case "plan": {
        const runId = view.plans.get(item.planId)?.runId;
        if (runId !== undefined) {
          return runId;
        }
        break;
      }
      case "verification":
      case "run":
        return item.runId;
      default:
        break;
    }
  }
  return null;
}
