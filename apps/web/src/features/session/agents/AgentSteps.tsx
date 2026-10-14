/**
 * A subagent's own steps, drawn the way the main timeline draws the primary
 * agent's: its calls fold into activity groups and its words stand beneath
 * them (`timeline-turns.ts`, `ActivityGroup.tsx`).
 */
import { type AgentView, agentStatusOf, type SessionView } from "@oncue/protocol";
import { ActivityGroup } from "../ActivityGroup";
import { TimelineRow } from "../Timeline";
import { groupTimeline, itemKey } from "../timeline-turns";

export function AgentSteps({
  view,
  agent,
  sessionId,
}: {
  readonly view: SessionView;
  readonly agent: AgentView;
  readonly sessionId: string | null;
}) {
  const running = agentStatusOf(view, agent) === "running";
  // A subagent's turn has no copy control of its own; its report is the result
  // below. It never starts a run, so it has no change of model to mark either.
  const units = groupTimeline(view, agent.timeline).filter(
    (unit) => unit.kind === "item" || unit.kind === "activity",
  );
  if (units.length === 0) {
    return running ? (
      <p className="shimmer text-[13px] text-muted-foreground" data-testid="agent-steps-waiting">
        Starting
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-1">
      {units.map((unit, index) => {
        if (unit.kind === "item") {
          return (
            <div key={unit.key} className="min-w-0">
              <TimelineRow view={view} item={unit.item} sessionId={sessionId} />
            </div>
          );
        }
        return (
          <div key={unit.key} className="min-w-0">
            <ActivityGroup
              view={view}
              items={unit.items}
              phase={unit.phase}
              live={running && index === units.length - 1}
            >
              {unit.items.map((item) => (
                <div key={itemKey(item)} className="min-w-0">
                  <TimelineRow view={view} item={item} sessionId={sessionId} />
                </div>
              ))}
            </ActivityGroup>
          </div>
        );
      })}
    </div>
  );
}
