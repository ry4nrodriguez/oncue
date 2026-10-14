/**
 * The step that started a subagent, as one row on the timeline (record 13,
 * "Agents"): a mark, the primary agent's own description of the task, and a
 * chevron that opens the subagent in the side panel. Its work is shown there,
 * never folded into the primary agent's activity.
 */
import { type AgentView, agentStatusOf, type SessionView } from "@oncue/protocol";
import { ChevronRight, Diamond } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_WORD } from "./agent-model";

export function AgentLaunchRow({
  view,
  agent,
  onOpen,
}: {
  readonly view: SessionView;
  readonly agent: AgentView;
  /** Opens the subagent's detail; absent on a read-only surface, where the row does not open. */
  readonly onOpen?: ((agentId: string) => void) | undefined;
}) {
  const status = agentStatusOf(view, agent);
  // A completed row rests without a word. A running one moves instead of
  // saying so, which a screen reader cannot hear and reduced motion stops: its
  // word is in the row's name always, and on the row when nothing moves.
  const word = status === "completed" ? null : STATUS_WORD[status];
  const content = (
    <>
      <Diamond className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          status === "running" ? "shimmer text-text" : "text-text",
        )}
      >
        {agent.description}
      </span>
      {word === null ? null : (
        <span
          data-testid="row-agent-status"
          className={cn(
            "shrink-0 text-[12px]",
            status === "failed" ? "text-danger" : "text-faint",
            status === "running" ? "hidden motion-reduce:inline" : "",
          )}
        >
          {word}
        </span>
      )}
      {onOpen === undefined ? null : (
        <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
      )}
    </>
  );
  const shape =
    "my-1 flex w-full max-w-[460px] items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-[13px]";
  return onOpen === undefined ? (
    <div data-testid="row-agent" data-status={status} className={shape}>
      {content}
    </div>
  ) : (
    <button
      type="button"
      data-testid="row-agent"
      data-status={status}
      aria-label={`Open subagent: ${agent.description}${word === null ? "" : `, ${word}`}`}
      onClick={() => onOpen(agent.agentId)}
      className={cn(
        shape,
        "transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
      )}
    >
      {content}
    </button>
  );
}

/**
 * The pill at the live edge of the timeline while subagents run; it opens the
 * Agents view. The timeline places it: beside the line that says what the
 * agent is doing now, or on a line of its own when there is none.
 */
export function RunningAgentsPill({
  count,
  label,
  onOpen,
}: {
  readonly count: number;
  readonly label: string;
  readonly onOpen?: (() => void) | undefined;
}) {
  if (count === 0) {
    return null;
  }
  const shape =
    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2.5 py-0.5 text-[12px] text-muted-foreground";
  const dot = <span className="size-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />;
  return onOpen === undefined ? (
    <span className={shape} data-testid="running-agents-pill">
      {dot}
      {label}
    </span>
  ) : (
    <button
      type="button"
      data-testid="running-agents-pill"
      onClick={onOpen}
      className={cn(
        shape,
        "transition-colors hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent",
      )}
    >
      {dot}
      {label}
    </button>
  );
}
