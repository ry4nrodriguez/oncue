/**
 * The side panel's Agents view (record 13, "Agents"): the run's subagents,
 * running first, then finished, and one subagent's own detail. Every string
 * from a payload renders as text or as the same markdown an agent's message
 * renders as; nothing from the sandbox is a label of OnCue's own.
 */
import { type AgentView, agentStatusOf, type SessionView } from "@oncue/protocol";
import { ChevronDown, ChevronLeft, ChevronRight, Square, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ModelConnectionSummary } from "@/lib/api/setup";
import { cn } from "@/lib/utils";
import { formatElapsed, useNow } from "../sandbox-time";
import { AgentSteps } from "./AgentSteps";
import {
  agentActivity,
  agentElapsedMs,
  agentLastWords,
  agentTokens,
  agentToolCount,
  agentTypeWord,
  finishedAgents,
  formatTokens,
  formatToolUses,
  modelName,
  runningAgents,
  STATUS_WORD,
} from "./agent-model";

export type AgentsPaneProps = {
  readonly view: SessionView;
  readonly sessionId: string | null;
  /** The subagent whose detail is open; null shows the list. */
  readonly selectedAgentId: string | null;
  readonly onSelectAgent: (agentId: string | null) => void;
  /** Asks the run to stop one subagent. Absent where nothing can be stopped. */
  readonly onStopAgent?: ((agentId: string) => void) | undefined;
  /** Subagents whose stop is out or was accepted, and not yet reported ended. */
  readonly stopping?: ReadonlySet<string> | undefined;
  /** Why a subagent's last stop failed, in words, by subagent. */
  readonly stopProblems?: ReadonlyMap<string, string> | undefined;
  /** Subagents the reader cleared from the finished list. */
  readonly cleared: ReadonlySet<string>;
  readonly onClearFinished: (agentIds: readonly string[]) => void;
  /** The workspace's catalog, for the model's own name. */
  readonly modelConnections: readonly ModelConnectionSummary[];
};

type Fact = { readonly key: string; readonly node: ReactNode };

/**
 * Short facts on one line with a middle dot between them. In a narrow panel
 * the line wraps between facts, and a long one (a model's id) breaks inside,
 * so nothing is cut off at the panel's edge.
 */
function FactLine({
  facts,
  className,
  testId,
}: {
  facts: readonly (Fact | null)[];
  className?: string;
  testId?: string;
}) {
  const shown = facts.filter((fact): fact is Fact => fact !== null);
  return (
    <p className={cn("flex flex-wrap items-baseline gap-x-1.5", className)} data-testid={testId}>
      {shown.map((fact, index) => (
        <span key={fact.key} className="wrap-anywhere min-w-0">
          {fact.node}
          {index === shown.length - 1 ? null : (
            <span className="ml-1.5 text-faint" aria-hidden="true">
              ·
            </span>
          )}
        </span>
      ))}
    </p>
  );
}

function RunningRow({
  view,
  agent,
  now,
  model,
  stopping,
  stopProblem,
  onOpen,
  onStop,
}: {
  view: SessionView;
  agent: AgentView;
  now: number;
  model: string | null;
  stopping: boolean;
  stopProblem: string | null;
  onOpen: () => void;
  onStop: (() => void) | undefined;
}) {
  // A turn's tokens are known when its message completes, so none is shown until one has.
  const tokens = agentTokens(view, agent);
  return (
    <li
      data-testid="agent-running-row"
      className="rounded-lg border border-border px-3 py-2.5"
      aria-label={agent.description}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-words font-medium text-[13px] text-text">
          {agent.description}
        </p>
        {onStop === undefined ? null : (
          <button
            type="button"
            data-testid="agent-stop"
            aria-label={`Stop subagent: ${agent.description}`}
            aria-busy={stopping}
            disabled={stopping}
            onClick={onStop}
            className="-mt-0.5 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          >
            <Square className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <FactLine
        className="mt-0.5 text-[12px] text-muted-foreground"
        facts={[
          { key: "type", node: agentTypeWord(agent.name) },
          {
            key: "elapsed",
            node: (
              <span className="font-mono tabular-nums">
                {formatElapsed(agentElapsedMs(view, agent, now))}
              </span>
            ),
          },
        ]}
      />
      <FactLine
        className="mt-0.5 text-[12px] text-faint"
        facts={[
          model === null ? null : { key: "model", node: model },
          tokens === 0 ? null : { key: "tokens", node: formatTokens(tokens) },
          { key: "tools", node: formatToolUses(agentToolCount(view, agent)) },
          {
            key: "activity",
            node: (
              <span className="shimmer text-muted-foreground" data-testid="agent-activity">
                {stopping ? "Stopping" : agentActivity(view, agent)}
              </span>
            ),
          },
        ]}
      />
      {stopProblem === null ? null : (
        <p
          role="status"
          data-testid="agent-stop-problem"
          className="mt-0.5 text-[12px] text-danger"
        >
          Stop subagent: {stopProblem}
        </p>
      )}
      <button
        type="button"
        data-testid="agent-view-transcript"
        data-agent-open={agent.agentId}
        onClick={onOpen}
        className="mt-1 text-[12px] text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        View transcript
      </button>
    </li>
  );
}

function FinishedRow({
  view,
  agent,
  onOpen,
}: {
  view: SessionView;
  agent: AgentView;
  onOpen: () => void;
}) {
  const status = agentStatusOf(view, agent);
  return (
    <li>
      <button
        type="button"
        data-testid="agent-finished-row"
        data-agent-open={agent.agentId}
        onClick={onOpen}
        className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text">{agent.description}</span>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">
            {agentTypeWord(agent.name)}
            <span className={cn("ml-2", status === "failed" ? "text-danger" : "")}>
              {STATUS_WORD[status]}
            </span>
          </span>
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
      </button>
    </li>
  );
}

function AgentList({
  view,
  onSelectAgent,
  onStopAgent,
  stopping,
  stopProblems,
  cleared,
  onClearFinished,
  modelConnections,
}: Omit<AgentsPaneProps, "selectedAgentId" | "sessionId">) {
  const running = runningAgents(view);
  const finished = finishedAgents(view, cleared);
  const now = useNow(running.length > 0);
  const [finishedOpen, setFinishedOpen] = useState(true);
  if (running.length === 0 && finished.length === 0) {
    return (
      <div className="px-4 pt-4" data-testid="agents-empty">
        <p className="font-medium text-[13px] text-text">No subagents yet</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          When the agent starts a subagent to look into something, it appears here with what it is
          doing.
        </p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" data-testid="agents-list">
      {running.length === 0 ? null : (
        <section aria-labelledby="agents-running-heading" data-testid="agents-running">
          <h3
            id="agents-running-heading"
            className="px-1 pt-3 pb-2 text-[12px] text-muted-foreground"
          >
            Running
          </h3>
          <ul className="flex flex-col gap-2">
            {running.map((agent) => (
              <RunningRow
                key={agent.agentId}
                view={view}
                agent={agent}
                now={now}
                model={modelName(agent.model, modelConnections)}
                stopping={stopping?.has(agent.agentId) === true}
                stopProblem={stopProblems?.get(agent.agentId) ?? null}
                onOpen={() => onSelectAgent(agent.agentId)}
                onStop={onStopAgent === undefined ? undefined : () => onStopAgent(agent.agentId)}
              />
            ))}
          </ul>
        </section>
      )}
      {finished.length === 0 ? null : (
        <Collapsible
          open={finishedOpen}
          onOpenChange={setFinishedOpen}
          data-testid="agents-finished"
          className="mt-2"
        >
          <div className="flex items-center gap-1 pt-2">
            <CollapsibleTrigger
              data-testid="agents-finished-toggle"
              className="group flex items-center gap-1.5 rounded-md px-1 py-1 text-[12px] text-muted-foreground hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              Finished <span className="tabular-nums">{finished.length}</span>
              <ChevronDown
                className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"
                aria-hidden="true"
              />
            </CollapsibleTrigger>
            <button
              type="button"
              data-testid="agents-clear-finished"
              aria-label="Clear finished subagents"
              onClick={() => onClearFinished(finished.map((agent) => agent.agentId))}
              className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <CollapsibleContent>
            <ul className="mt-1 flex flex-col gap-2">
              {finished.map((agent) => (
                <FinishedRow
                  key={agent.agentId}
                  view={view}
                  agent={agent}
                  onOpen={() => onSelectAgent(agent.agentId)}
                />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** A long prompt starts folded: about eight lines, then "Show more". */
const PROMPT_FOLD_CHARS = 480;

function AgentDetail({
  view,
  sessionId,
  agent,
  onBack,
  modelConnections,
}: {
  view: SessionView;
  sessionId: string | null;
  agent: AgentView;
  onBack: () => void;
  modelConnections: readonly ModelConnectionSummary[];
}) {
  const status = agentStatusOf(view, agent);
  const now = useNow(status === "running");
  const [expanded, setExpanded] = useState(false);
  const long = agent.prompt.length > PROMPT_FOLD_CHARS || agent.prompt.split("\n").length > 8;
  const model = modelName(agent.model, modelConnections);
  // The control that opened the detail is gone once it shows, so focus moves
  // to its heading instead of falling back to the page.
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-detail">
      <div className="flex items-center gap-1 px-2 pb-1">
        <button
          type="button"
          aria-label="Back to agents"
          data-testid="agent-detail-back"
          onClick={onBack}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <h3
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate rounded-sm font-medium text-[14px] text-text focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="agent-detail-title"
        >
          {agent.description}
        </h3>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" data-testid="agent-detail-scroll">
        <FactLine
          testId="agent-detail-meta"
          className="text-[12px] text-muted-foreground"
          facts={[
            model === null
              ? null
              : {
                  key: "model",
                  node: (
                    <>
                      Model <span className="text-text">{model}</span>
                    </>
                  ),
                },
            { key: "type", node: agentTypeWord(agent.name) },
            {
              key: "status",
              // The status and its duration stay together and whole.
              node: (
                <span className="whitespace-nowrap">
                  <span className={status === "failed" ? "text-danger" : ""}>
                    {STATUS_WORD[status]}
                  </span>{" "}
                  <span className="font-mono tabular-nums" data-testid="agent-detail-elapsed">
                    {formatElapsed(agentElapsedMs(view, agent, now))}
                  </span>
                </span>
              ),
            },
          ]}
        />
        {agent.prompt.length === 0 ? null : (
          <div
            className="mt-3 rounded-lg bg-surface px-3 py-2.5 text-[13px] text-text"
            data-testid="agent-prompt"
          >
            <div
              className={cn(
                "relative min-w-0 overflow-hidden break-words",
                long && !expanded ? "max-h-40" : "",
              )}
              data-expanded={expanded ? "true" : "false"}
            >
              <MessageResponse>{agent.prompt}</MessageResponse>
              {long && !expanded ? (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface"
                  aria-hidden="true"
                />
              ) : null}
            </div>
            {agent.promptTruncated ? (
              <p className="mt-2 text-[12px] text-faint">The prompt was cut at 4 KB.</p>
            ) : null}
            {long ? (
              <button
                type="button"
                data-testid="agent-prompt-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
                className="mt-2 text-[12px] text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
        )}
        <div className="mt-4" data-testid="agent-steps">
          <AgentSteps view={view} agent={agent} sessionId={sessionId} />
        </div>
        {status === "running" ||
        // Its report is usually its last words, which the steps already show.
        (status === "completed" &&
          agent.resultSummary !== null &&
          agent.resultSummary.trim() === agentLastWords(view, agent)) ? null : (
          <div className="mt-4" data-testid="agent-result">
            <p className="text-[12px] text-muted-foreground">
              {status === "completed" ? "What it reported" : STATUS_WORD[status]}
            </p>
            {agent.resultSummary === null ? (
              <p className="mt-1 text-[13px] text-muted-foreground">
                {status === "cancelled"
                  ? "It was stopped before it reported back."
                  : "It reported nothing."}
              </p>
            ) : (
              <div className="mt-1 text-[13px] text-text">
                <MessageResponse>{agent.resultSummary}</MessageResponse>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentsPane(props: AgentsPaneProps) {
  const { onSelectAgent } = props;
  const selected =
    props.selectedAgentId === null
      ? undefined
      : props.view.agents.get(props.selectedAgentId as never);
  const selectedId = selected?.agentId ?? null;
  const root = useRef<HTMLDivElement | null>(null);
  // Back unmounts its own button, so focus returns to the row of the subagent
  // it came from, or to the pane when that row is no longer listed.
  const returnTo = useRef<string | null>(null);
  const back = useCallback(() => {
    returnTo.current = selectedId;
    onSelectAgent(null);
  }, [selectedId, onSelectAgent]);
  useEffect(() => {
    const agentId = returnTo.current;
    if (selectedId !== null || agentId === null) {
      return;
    }
    returnTo.current = null;
    const rows = root.current?.querySelectorAll<HTMLElement>("[data-agent-open]") ?? [];
    const row = [...rows].find((element) => element.dataset.agentOpen === agentId);
    (row ?? root.current)?.focus();
  }, [selectedId]);
  return (
    <div
      ref={root}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      data-testid="panel-agents"
    >
      {selected === undefined ? (
        <AgentList {...props} />
      ) : (
        <AgentDetail
          // Each subagent's detail is its own: the prompt's fold and the scroll start over.
          key={selected.agentId}
          view={props.view}
          sessionId={props.sessionId}
          agent={selected}
          onBack={back}
          modelConnections={props.modelConnections}
        />
      )}
    </div>
  );
}
