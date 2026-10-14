/**
 * What the timeline and the Agents view say about subagents (record 13,
 * "Agents"), read from the view alone. A subagent's rows are the shared
 * `view.tools` and `view.messages` entries its own timeline names.
 */
import {
  type AgentStatus,
  type AgentView,
  agentStatusOf,
  type SessionView,
  type ToolView,
} from "@oncue/protocol";
import type { ModelConnectionSummary } from "@/lib/api/setup";
import { spentOf } from "../context-meter";

/** The primary agent's call that started each subagent, so the timeline can draw that call as the subagent's row. */
export function agentsByCall(view: SessionView): ReadonlyMap<ToolView["toolCallId"], AgentView> {
  const byCall = new Map<ToolView["toolCallId"], AgentView>();
  for (const agent of view.agents.values()) {
    if (agent.parentToolCallId !== null) {
      byCall.set(agent.parentToolCallId, agent);
    }
  }
  return byCall;
}

/** Newest started first, as the Agents view lists them. */
function newestFirst(agents: Iterable<AgentView>): AgentView[] {
  return [...agents].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function runningAgents(view: SessionView): readonly AgentView[] {
  return newestFirst(
    [...view.agents.values()].filter((agent) => agentStatusOf(view, agent) === "running"),
  );
}

/** Ended subagents, less the ones the reader cleared from the list. */
export function finishedAgents(
  view: SessionView,
  cleared: ReadonlySet<string>,
): readonly AgentView[] {
  return newestFirst(
    [...view.agents.values()].filter(
      (agent) => agentStatusOf(view, agent) !== "running" && !cleared.has(agent.agentId),
    ),
  );
}

export const STATUS_WORD: Record<AgentStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
};

/**
 * When the subagent stopped: its own reported end, else the end of its run,
 * which took it down without a report (a lost sandbox). Null while it runs.
 */
export function agentEndedAt(view: SessionView, agent: AgentView): string | null {
  return agent.endedAt ?? view.runs.get(agent.runId)?.endedAt ?? null;
}

/** How long it has run, or ran: up to `now` only while nothing has ended it. */
export function agentElapsedMs(view: SessionView, agent: AgentView, now: number): number {
  const endedAt = agentEndedAt(view, agent);
  return Math.max(0, (endedAt === null ? now : Date.parse(endedAt)) - Date.parse(agent.startedAt));
}

/** "general" reads as a person's word on the row: "General", "Explore". */
export function agentTypeWord(name: string): string {
  return name.length === 0 ? name : `${name[0]?.toUpperCase()}${name.slice(1)}`;
}

/** The subagent's calls, in order. */
export function agentTools(view: SessionView, agent: AgentView): readonly ToolView[] {
  const tools: ToolView[] = [];
  for (const item of agent.timeline) {
    if (item.kind === "tool") {
      const tool = view.tools.get(item.toolCallId);
      if (tool !== undefined) {
        tools.push(tool);
      }
    }
  }
  return tools;
}

/**
 * Tokens so far: the sum of its messages' usage, or the total its end reported
 * when that is larger. An end the session wrote for a subagent whose sandbox
 * was lost reports none, and what its answers had already spent still shows.
 */
export function agentTokens(view: SessionView, agent: AgentView): number {
  // What its answers spent, cache reads and writes included, as the bridge
  // counts it for `agent.completed`; never each answer's context size.
  let total = 0;
  for (const item of agent.timeline) {
    if (item.kind === "message") {
      const usage = view.messages.get(item.messageId)?.usage;
      if (usage !== null && usage !== undefined) {
        const spent = spentOf(usage);
        total += spent.input + spent.cacheRead + spent.cacheWrite + spent.output;
      }
    }
  }
  return Math.max(total, agent.usage?.tokens ?? 0);
}

/** Calls so far: the ones on its timeline, or the count its end reported when that is larger. */
export function agentToolCount(view: SessionView, agent: AgentView): number {
  return Math.max(agentTools(view, agent).length, agent.usage?.toolCalls ?? 0);
}

/** "67.5k tokens", "820 tokens", "1 token". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k tokens`;
  }
  return `${tokens} ${tokens === 1 ? "token" : "tokens"}`;
}

export function formatToolUses(count: number): string {
  return `${count} ${count === 1 ? "tool use" : "tool uses"}`;
}

const ACTIVITY: Record<ToolView["category"], string> = {
  shell: "Running a command",
  git_local: "Running a command",
  git_remote: "Running a command",
  file_read: "Reading a file",
  file_write: "Editing a file",
  search: "Searching",
  web: "Reading a page",
  browser: "Reading a page",
  verification: "Running a check",
  artifact: "Saving an artifact",
  policy_propose: "Proposing a change",
  other: "Working",
};

/** What a running subagent is doing now: its unfinished call, else thinking. */
export function agentActivity(view: SessionView, agent: AgentView): string {
  const current = agentTools(view, agent).findLast(
    (tool) => tool.result === null && tool.failure === null,
  );
  return current === undefined ? "Thinking" : ACTIVITY[current.category];
}

/** The model's own name from the workspace's catalog, else its id. */
export function modelName(
  model: AgentView["model"],
  connections: readonly ModelConnectionSummary[],
): string | null {
  if (model === null) {
    return null;
  }
  for (const connection of connections) {
    const spec = connection.models?.find((entry) => entry.modelId === model.modelId);
    if (spec !== undefined) {
      return spec.name;
    }
  }
  return model.modelId;
}

/** The text of the subagent's last message, trimmed; empty when it said nothing. */
export function agentLastWords(view: SessionView, agent: AgentView): string {
  for (const item of [...agent.timeline].reverse()) {
    if (item.kind !== "message") {
      continue;
    }
    const text = (view.messages.get(item.messageId)?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

/** "1 running agent", "3 running agents". */
export function runningAgentsLabel(count: number): string {
  return `${count} running ${count === 1 ? "agent" : "agents"}`;
}
