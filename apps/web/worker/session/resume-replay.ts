// Folds committed events into the turns `composeResumeContext` replays, one
// turn per `run.queued`. The object reads the rows newest first, bounded per
// event type, once per resume and never per frame (record 01). Events of a run
// whose `run.queued` was not read are counted, not shown.

import type { ProtocolEvent, ProtocolEventOf } from "@oncue/protocol";
import type {
  ResumeCheck,
  ResumePlan,
  ResumeQuestion,
  ResumeSubagent,
  ResumeToolCall,
  ResumeTurn,
  ToolOutcome,
} from "./resume-context";

/** The prompt a resume sends when no user message starts it. It is OnCue's text, never the user's. */
export const RESUME_PROMPT_TEXT = "Continue the work in progress from the checkpoint.";

/** One committed event and the run its row names. */
export interface ReplayRow {
  readonly sequence: number;
  readonly runId: string | null;
  readonly event: ProtocolEvent;
}

/**
 * The event types read for a replay, each with its own row bound. One type per
 * read, so it walks `idx_event_type_generation` from the newest end and stops
 * at the bound instead of sorting every row of the type. A `primaryOnly` read
 * walks `idx_event_primary_type` instead, so a subagent's own messages and
 * calls, which a turn never shows, take none of the bound.
 */
export const REPLAY_READS: readonly {
  readonly type: ProtocolEvent["type"];
  readonly limit: number;
  readonly primaryOnly?: true;
}[] = [
  { type: "run.queued", limit: 200 },
  { type: "message.queued", limit: 200 },
  { type: "message.completed", limit: 400, primaryOnly: true },
  { type: "tool.requested", limit: 1500, primaryOnly: true },
  { type: "tool.completed", limit: 1500, primaryOnly: true },
  { type: "tool.failed", limit: 500, primaryOnly: true },
  { type: "diff.updated", limit: 400 },
  { type: "verification.started", limit: 400 },
  { type: "verification.result", limit: 400 },
  { type: "run.verified", limit: 200 },
  { type: "run.completed_with_warnings", limit: 200 },
  { type: "run.completed", limit: 200 },
  { type: "run.blocked", limit: 200 },
  { type: "run.failed", limit: 200 },
  { type: "run.cancelled", limit: 200 },
  { type: "run.interrupted", limit: 200 },
  { type: "question.asked", limit: 50 },
  { type: "question.answered", limit: 50 },
  { type: "question.dismissed", limit: 50 },
  { type: "plan.created", limit: 1 },
  { type: "plan.updated", limit: 1 },
  { type: "plan.completed", limit: 1 },
  { type: "plan.cancelled", limit: 1 },
  { type: "agent.started", limit: 100 },
  { type: "agent.completed", limit: 100 },
];

const OUTCOME_WORDS: Partial<Record<ProtocolEvent["type"], string>> = {
  "run.verified": "verified",
  "run.completed_with_warnings": "with warnings",
  "run.completed": "done, with no files changed",
  "run.blocked": "blocked",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.interrupted": "interrupted",
};

/** The title the bridge gives the row that carries unmapped runtime events; it is not a tool call. */
const DEBUG_TOOL_TITLE = "Unmapped runtime events";

const PATH_KEYS = new Set(["path", "paths", "filepath", "file_path", "filename", "file", "files"]);

/** Paths a tool call's input names, whichever harness named them: string values under a path-like key. */
export function pathsIn(input: unknown): string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!PATH_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) {
          paths.push(item);
        }
      }
    }
  }
  return paths;
}

interface TurnDraft {
  runId: string;
  instruction: string | null;
  steers: string[];
  tools: Map<string, { name: string; category: string; outcome: ToolOutcome; paths: string[] }>;
  filesChanged: string[];
  checkNames: Map<string, string>;
  checks: Map<string, string>;
  checksOnly: boolean;
  outcome: string | null;
  finalMessage: string | null;
  subagents: Map<string, ResumeSubagent>;
  questions: Map<string, ResumeQuestion>;
}

export interface ReplayFold {
  readonly turns: readonly ResumeTurn[];
  readonly unreadEarlierTurns: number;
  readonly plan: ResumePlan | null;
}

function textOf(event: ProtocolEventOf<"message.completed">): string {
  return event.payload.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function isEmpty(turn: TurnDraft): boolean {
  return (
    turn.instruction === null &&
    turn.steers.length === 0 &&
    turn.tools.size === 0 &&
    turn.filesChanged.length === 0 &&
    turn.checks.size === 0 &&
    !turn.checksOnly &&
    turn.outcome === null &&
    turn.finalMessage === null &&
    turn.subagents.size === 0 &&
    turn.questions.size === 0
  );
}

/**
 * A subagent's own messages and calls are not the primary agent's turn; the
 * turn shows each subagent as one line instead (record 12). The object's
 * `primaryOnly` reads already leave them out; rows from any other caller are
 * held to the same rule here.
 */
function bySubagent(event: ProtocolEvent): boolean {
  return (event.payload as { readonly agentId?: string }).agentId !== undefined;
}

/** `promptMessageId`'s text is left out of the replay: the agent receives it as the prompt. */
export function foldReplay(input: {
  readonly rows: readonly ReplayRow[];
  readonly promptMessageId: string;
}): ReplayFold {
  const rows = [...input.rows].sort((a, b) => a.sequence - b.sequence);
  const turns = new Map<string, TurnDraft>();
  const unread = new Set<string>();
  let plan: ResumePlan | null = null;

  const turnOf = (runId: string | null): TurnDraft | undefined => {
    if (runId === null) {
      return undefined;
    }
    const turn = turns.get(runId);
    if (turn === undefined) {
      unread.add(runId);
    }
    return turn;
  };

  for (const { runId, event } of rows) {
    switch (event.type) {
      case "run.queued": {
        if (runId === null) {
          break;
        }
        const { instruction, trigger } = event.payload;
        const text =
          instruction.messageId === input.promptMessageId ||
          trigger === "checks_requested" ||
          instruction.text === RESUME_PROMPT_TEXT
            ? null
            : instruction.text;
        turns.set(runId, {
          runId,
          instruction: text,
          steers: [],
          tools: new Map(),
          filesChanged: [],
          checkNames: new Map(),
          checks: new Map(),
          checksOnly: trigger === "checks_requested",
          outcome: null,
          finalMessage: null,
          subagents: new Map(),
          questions: new Map(),
        });
        unread.delete(runId);
        break;
      }
      case "message.queued": {
        const { delivery, deliveredToRunId, messageId, text } = event.payload;
        if (delivery !== "steer_current_run" || messageId === input.promptMessageId) {
          break;
        }
        turnOf(deliveredToRunId)?.steers.push(text);
        break;
      }
      case "message.completed": {
        if (event.payload.role !== "assistant" || bySubagent(event)) {
          break;
        }
        const turn = turnOf(runId);
        const text = textOf(event);
        if (turn !== undefined && text.trim().length > 0) {
          turn.finalMessage = text;
        }
        break;
      }
      case "tool.requested": {
        const turn = turnOf(runId);
        const { toolCallId, title, runtimeName, category, input: toolInput } = event.payload;
        if (turn === undefined || title === DEBUG_TOOL_TITLE || bySubagent(event)) {
          break;
        }
        const earlier = turn.tools.get(toolCallId);
        turn.tools.set(toolCallId, {
          name: title.length > 0 ? title : runtimeName,
          category,
          outcome: earlier?.outcome ?? "unfinished",
          paths: pathsIn(toolInput),
        });
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        const tool = turnOf(runId)?.tools.get(event.payload.toolCallId);
        if (tool !== undefined) {
          tool.outcome = event.type === "tool.completed" ? "completed" : "failed";
        }
        break;
      }
      case "diff.updated": {
        const turn = turnOf(runId);
        if (turn !== undefined && event.payload.scope === "turn") {
          turn.filesChanged = event.payload.files.map((file) => file.path);
        }
        break;
      }
      case "verification.started": {
        turnOf(runId)?.checkNames.set(event.payload.checkId, event.payload.name);
        break;
      }
      case "verification.result": {
        turnOf(runId)?.checks.set(event.payload.checkId, event.payload.result);
        break;
      }
      case "question.asked": {
        turnOf(runId)?.questions.set(event.payload.questionId, {
          asked: event.payload.questions.map((question) => question.text),
          answers: null,
          outcome: "open",
        });
        break;
      }
      case "question.answered":
      case "question.dismissed": {
        const question = turnOf(runId)?.questions.get(event.payload.questionId);
        if (question !== undefined) {
          turnOf(runId)?.questions.set(
            event.payload.questionId,
            event.type === "question.answered"
              ? { ...question, answers: event.payload.answers, outcome: "answered" }
              : {
                  ...question,
                  answers: null,
                  outcome: "dismissed",
                  dismissal: event.payload.reason,
                },
          );
        }
        break;
      }
      case "plan.created":
      case "plan.updated":
        plan = {
          steps: event.payload.steps.map((step) => ({ title: step.title, status: step.status })),
          completed: false,
        };
        break;
      case "plan.completed":
        if (plan !== null) {
          plan = { steps: plan.steps, completed: true };
        }
        break;
      case "plan.cancelled":
        plan = null;
        break;
      case "agent.started": {
        const { agentId, name, description } = event.payload;
        turnOf(runId)?.subagents.set(agentId, {
          name,
          description,
          status: "running",
          result: null,
        });
        break;
      }
      case "agent.completed": {
        const subagent = turnOf(runId)?.subagents.get(event.payload.agentId);
        if (subagent !== undefined) {
          subagent.status = event.payload.status;
          subagent.result = event.payload.resultSummary;
        }
        break;
      }
      default: {
        const words = OUTCOME_WORDS[event.type];
        const turn = turnOf(runId);
        if (words !== undefined && turn !== undefined) {
          turn.outcome = words;
        }
      }
    }
  }

  const folded: ResumeTurn[] = [];
  for (const turn of turns.values()) {
    if (isEmpty(turn)) {
      continue;
    }
    const checks: ResumeCheck[] = [...turn.checks].map(([checkId, result]) => ({
      name: turn.checkNames.get(checkId) ?? checkId,
      result,
    }));
    const tools: ResumeToolCall[] = [...turn.tools.values()];
    folded.push({
      runId: turn.runId,
      instruction: turn.instruction,
      checksOnly: turn.checksOnly,
      steers: turn.steers,
      tools,
      filesChanged: turn.filesChanged,
      checks,
      outcome: turn.outcome,
      finalMessage: turn.finalMessage,
      ...(turn.subagents.size === 0 ? {} : { subagents: [...turn.subagents.values()] }),
      ...(turn.questions.size === 0 ? {} : { questions: [...turn.questions.values()] }),
    });
  }
  return { turns: folded, unreadEarlierTurns: unread.size, plan };
}
