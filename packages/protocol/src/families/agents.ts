import { defineFamily } from "../define";
import {
  agentId,
  boolean,
  counter,
  nullable,
  picklist,
  shortText,
  strictObject,
  summaryText,
  toolCallId,
} from "../schema";

// Record 12: the subagents a harness may start for the primary agent. Only
// OpenCode's two built-in ones are allowed; a repository's own agents are not.
export const SUBAGENT_NAMES = ["general", "explore"] as const;
export const subagentName = picklist(SUBAGENT_NAMES);

export const subagentStatus = picklist(["completed", "failed", "cancelled"]);

// A subagent's events are the run's events: its messages and tool calls carry
// its `agentId`, and these two bracket them. `parentToolCallId` is the primary
// agent's call that started it: the timeline shows that call as one row for
// the subagent, and the subagent's own work opens in the Agents view.
export const AGENT_EVENTS = defineFamily("agents", {
  "agent.started": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      agentId,
      parentToolCallId: toolCallId,
      name: subagentName,
      description: shortText,
      // The task the primary agent wrote for it, cut to the summary limit;
      // `promptTruncated` says so. The model's own words, never a decision.
      prompt: summaryText,
      promptTruncated: boolean(),
      model: nullable(strictObject({ provider: shortText, modelId: shortText })),
    }),
  },
  // From either side: the bridge reports a subagent's end, and the object
  // ends the ones a lost sandbox left running, which nothing else will report.
  "agent.completed": {
    scope: "run",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      agentId,
      status: subagentStatus,
      usage: strictObject({ tokens: counter, toolCalls: counter, durationMs: counter }),
      // What it reported back, or why it stopped; cut to the summary limit.
      resultSummary: nullable(summaryText),
    }),
  },
});
