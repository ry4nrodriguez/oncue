/**
 * One closed group of the agent's work with a one-line headline: the running
 * tool while the group is the live edge of a run, else a summary such as
 * "Ran 4 commands, read 2 files · 4s". See `timeline-turns.ts` for grouping.
 */
import type { RunView, SessionView, TimelineItem, ToolView } from "@oncue/protocol";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatDuration } from "./actions";
import type { ActivityPhase } from "./timeline-turns";

/** Anything short of an ending: queued, running, waiting, paused, interrupted. */
export function runInProgress(run: RunView | undefined): boolean {
  return run !== undefined && run.ending === null && run.endedAt === null;
}

/** The group's tools, in timeline order. */
function toolsOf(view: SessionView, items: readonly TimelineItem[]): readonly ToolView[] {
  const tools: ToolView[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      const tool = view.tools.get(item.toolCallId);
      if (tool !== undefined) {
        tools.push(tool);
      }
    }
  }
  return tools;
}

/** A call that has neither finished nor failed: the one happening now, if any. */
function unfinished(tool: ToolView): boolean {
  return tool.result === null && tool.failure === null;
}

/** "4s" from the first call's request to the last call's end; `null` with nothing to measure. */
function spanOf(tools: readonly ToolView[]): string | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const tool of tools) {
    const requested = Date.parse(tool.requestedAt);
    if (!Number.isNaN(requested)) {
      start = Math.min(start, requested);
      end = Math.max(end, requested);
    }
    const started = tool.startedAt === null ? Number.NaN : Date.parse(tool.startedAt);
    if (!Number.isNaN(started)) {
      end = Math.max(end, started + (tool.durationMs ?? 0));
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return formatDuration(end - start);
}

/** What a category of tool call is, in the headline's words: a verb and a noun for one and for many. */
const TOOL_WORDS: Record<ToolView["category"], readonly [verb: string, one: string, many: string]> =
  {
    shell: ["Ran", "command", "commands"],
    git_local: ["Ran", "command", "commands"],
    git_remote: ["Ran", "command", "commands"],
    file_read: ["Read", "file", "files"],
    file_write: ["Edited", "file", "files"],
    search: ["Ran", "search", "searches"],
    web: ["Fetched", "page", "pages"],
    browser: ["Fetched", "page", "pages"],
    verification: ["Ran", "check", "checks"],
    artifact: ["Saved", "artifact", "artifacts"],
    policy_propose: ["Proposed", "change", "changes"],
    other: ["Took", "action", "actions"],
  };

/**
 * What a settled group did, e.g. "Ran 4 commands, read 2 files (1 failed)",
 * largest count first. A group with no calls counts its rows.
 */
export function describeActivity(tools: readonly ToolView[], itemCount: number): string {
  if (tools.length === 0) {
    return `${itemCount} ${itemCount === 1 ? "action" : "actions"}`;
  }
  const counts = new Map<string, { verb: string; one: string; many: string; count: number }>();
  for (const tool of tools) {
    const [verb, one, many] = TOOL_WORDS[tool.category];
    const key = `${verb} ${many}`;
    const entry = counts.get(key) ?? { verb, one, many, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const phrases = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .map((entry, index) => {
      const verb = index === 0 ? entry.verb : entry.verb.toLowerCase();
      return `${verb} ${entry.count} ${entry.count === 1 ? entry.one : entry.many}`;
    });
  const failed = tools.filter((tool) => tool.failure !== null).length;
  return `${phrases.join(", ")}${failed === 0 ? "" : ` (${failed} failed)`}`;
}

/** The words on the trigger, and whether they are in motion. */
export function activityHeadline(
  view: SessionView,
  items: readonly TimelineItem[],
  phase: ActivityPhase,
  live: boolean,
): { readonly label: string; readonly detail: string | null; readonly live: boolean } {
  const steps = `${items.length} ${items.length === 1 ? "action" : "actions"}`;
  if (phase === "checks") {
    const checks = items.flatMap((item) =>
      item.kind === "check" ? (view.verification.checks.get(item.checkId) ?? []) : [],
    );
    const settled = checks.filter(
      (check) => check.status !== "pending" && check.status !== "running",
    );
    if (live && settled.length < checks.length) {
      return { label: "Running checks", detail: steps, live: true };
    }
    const failed = checks.filter((check) => check.status === "failed").length;
    if (checks.length === 0) {
      return { label: "Checks", detail: steps, live: false };
    }
    return {
      label:
        failed === 0
          ? `Checks · ${checks.length} passed`
          : `Checks · ${failed} of ${checks.length} failed`,
      detail: steps,
      live: false,
    };
  }
  const tools = toolsOf(view, items);
  if (live) {
    // The call happening now, or the last one while the next is on its way.
    const current = tools.find(unfinished) ?? tools.at(-1);
    return { label: current?.title ?? "Working", detail: steps, live: true };
  }
  const span = spanOf(tools);
  return { label: describeActivity(tools, items.length), detail: span, live: false };
}

export function ActivityGroup({
  view,
  items,
  phase,
  live,
  aside,
  children,
}: {
  readonly view: SessionView;
  readonly items: readonly TimelineItem[];
  readonly phase: ActivityPhase;
  /** Whether this group is the live edge of a run in progress. */
  readonly live: boolean;
  /** Stands on the headline's line, right after it; the headline then takes only the room it needs. */
  readonly aside?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const headline = activityHeadline(view, items, phase, live);
  const beside = aside !== undefined && aside !== null;
  const trigger = (
    <CollapsibleTrigger
      data-testid="activity-trigger"
      aria-label={
        headline.detail === null ? headline.label : `${headline.label}, ${headline.detail}`
      }
      className={cn(
        "group flex items-center gap-2 rounded-md py-1.5 pr-2 pl-1 text-left text-[13px] hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
        beside ? "min-w-0" : "w-full",
      )}
    >
      <span
        className={cn(
          "min-w-0 truncate",
          headline.live ? "shimmer text-text" : "text-muted-foreground",
        )}
      >
        {headline.label}
      </span>
      {headline.detail === null ? null : (
        <span className="shrink-0 text-faint">· {headline.detail}</span>
      )}
      <ChevronDown
        className={cn(
          "size-3 shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180",
          beside ? "" : "ml-auto",
        )}
        aria-hidden="true"
      />
    </CollapsibleTrigger>
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-full"
      data-testid={phase === "checks" ? "row-checks" : "row-activity"}
      data-open={open ? "true" : "false"}
    >
      {beside ? (
        <div className="flex items-center gap-2" data-testid="activity-line">
          {trigger}
          {aside}
        </div>
      ) : (
        trigger
      )}
      {open ? (
        <CollapsibleContent>
          <div
            className="mt-0.5 mb-1 ml-2 border-border-soft border-l pl-3"
            data-testid="activity-rows"
          >
            {children}
          </div>
        </CollapsibleContent>
      ) : (
        // A plain hidden div, not the panel's `keepMounted`: that panel hides only
        // once every animation inside finishes, and a row's shimmer never does.
        <div hidden data-testid="activity-rows">
          {children}
        </div>
      )}
    </Collapsible>
  );
}
