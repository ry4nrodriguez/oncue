import {
  type ActionState,
  type MessagePart,
  type MessageView,
  RUN_OUTCOMES,
  type RunOutcome,
  type RunView,
  type SandboxActionView,
  type SessionView,
  type TimelineItem,
  type ToolView,
} from "@oncue/protocol";
import {
  ArrowLeftRight,
  Check,
  CircleDot,
  FileText,
  GitCommitHorizontal,
  GitPullRequest,
  ListChecks,
  Upload,
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  type ApprovalAnswer,
  ApprovalRow,
  SecretsDisclosedRow,
  SecretsSuppliedRow,
} from "@/features/approvals/ApprovalCard";
import { ChangeCard } from "@/features/diff/ChangeCard";
import type { ReviewTarget } from "@/features/diff/review-model";
import { displayModelName, shortModelName } from "@/features/model-connections/model-name";
import { type BranchChoice, type PolicyAnswer, PolicyRow } from "@/features/policy/PolicyCard";
import { QuestionRow } from "@/features/questions/QuestionRow";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { CheckRow } from "@/features/verification/CheckRow";
import { RunOutcomeRow } from "@/features/verification/outcomes";
import type { ModelCatalog, ModelProvider } from "@/lib/api/setup";
import { type ActionFact, ActionRow, type ActionRowState, type ActionStep } from "./ActionRow";
import { ActivityGroup, runInProgress } from "./ActivityGroup";
import {
  CATEGORY_MARK,
  FAILURE_SUMMARY,
  FAILURE_TONE,
  formatDuration,
  PROVIDER_MARK,
  resultOutput,
  SANDBOX_FAILURE_SUMMARY,
  toolFailureCategory,
} from "./actions";
import { AgentLaunchRow, RunningAgentsPill } from "./agents/AgentLaunchRow";
import { agentsByCall, runningAgents, runningAgentsLabel } from "./agents/agent-model";
import { useArtifactDownload } from "./artifact-download";
import { MessageAttachments } from "./attachments/MessageAttachments";
import { CopyResponse } from "./CopyResponse";
import { modelFailureOfRow, PausedRow } from "./PausedRow";
import {
  formatElapsed,
  sandboxInTransition,
  sandboxRunningMs,
  stepOffsets,
  useNow,
} from "./sandbox-time";
import { groupTimeline, itemKey, runOfActivity } from "./timeline-turns";
import type { AnswerHandler } from "./use-commands";

/**
 * Messages carry the most visual weight and activity stays quieter (record 13).
 * Every timeline kind has a renderer, so an unhandled event is a type error
 * rather than a blank row. A turn's work folds into one activity row
 * (`timeline-turns.ts`).
 */

// Derived from `SessionView["live"]`, since the package does not export these
// types by name; a hand-written copy would drift.
type LiveMessagePart = NonNullable<ReturnType<SessionView["live"]["messages"]["get"]>>[number];
type LiveToolOutput = NonNullable<ReturnType<SessionView["live"]["toolOutput"]["get"]>>;
type ArtifactView = NonNullable<ReturnType<SessionView["artifacts"]["get"]>>;

function QuietRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-[13px] text-muted-foreground">
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

function textOf(message: MessageView): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

/**
 * Renders text and code parts; other part types are dropped. Consecutive text
 * parts join into one markdown blob, so the run's own paragraph breaks are the
 * only ones Streamdown sees.
 */
function messageNodes(parts: readonly MessagePart[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) {
      nodes.push(<MessageResponse key={nodes.length}>{buffer}</MessageResponse>);
      buffer = "";
    }
  };
  for (const part of parts) {
    if (part.type === "text") {
      buffer += part.text;
    } else if (part.type === "code") {
      flush();
      nodes.push(<CodeBlock key={nodes.length} code={part.code} language={part.language} />);
    }
  }
  flush();
  return nodes;
}

/** The live buffer's own text parts, joined in arrival order. Reasoning summaries are dropped. */
function liveBufferText(live: readonly LiveMessagePart[] | undefined): string {
  return (live ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * OnCue never force-pushes (record 07), so a branch someone else moved on
 * refuses the push; the work is kept as a recovery patch.
 */
export const NON_FAST_FORWARD_HINT =
  "The branch has commits this session does not have, so nothing was overwritten. Your work is saved; ask the session to merge the branch, or start a new session from the branch as it is now.";
export function MessageRow({
  message,
  live,
  sessionId = null,
}: {
  message: MessageView;
  live?: readonly LiveMessagePart[] | undefined;
  /** Where the message's attachments are served from; without it they are not drawn. */
  sessionId?: string | null;
}) {
  if (message.role === "user") {
    const attachments = message.parts.flatMap((part) =>
      part.type === "artifact_ref" ? [part.artifact] : [],
    );
    return (
      // Spacing so the conversation reads in turns.
      <Message from="user" data-testid="row-message-user" className="mb-3">
        {sessionId === null ? null : (
          <MessageAttachments sessionId={sessionId} attachments={attachments} />
        )}
        <MessageContent>{textOf(message)}</MessageContent>
      </Message>
    );
  }

  if (message.streaming) {
    const bufferText = liveBufferText(live);
    return (
      <Message
        from="assistant"
        data-testid="row-message-assistant"
        aria-busy="true"
        className="mt-1.5"
      >
        <MessageContent>
          {bufferText.length === 0 ? (
            // A reconnect drops the live buffer; the committed parts arrive
            // with `message.completed`.
            <p className="text-[13px] text-muted-foreground" data-testid="streaming-placeholder">
              Partial text is not replayed; waiting for the message to finish
            </p>
          ) : (
            // Streamdown renders partial markdown correctly while tokens stream.
            <MessageResponse>{bufferText}</MessageResponse>
          )}
          <span
            className="shimmer inline-block size-1.5 shrink-0 rounded-full bg-accent"
            aria-hidden="true"
            data-testid="streaming-mark"
          />
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from="assistant" data-testid="row-message-assistant" className="mt-1.5">
      <MessageContent>{messageNodes(message.parts)}</MessageContent>
    </Message>
  );
}

/**
 * Collapses the seven `ToolUiState` values to the four a row shows; the failure
 * text tells the failed kinds apart. Only `tool.started` means work is under
 * way, so every pre-completion state checks `startedAt` before reading as running.
 */
export function toolRowState(tool: Pick<ToolView, "state" | "startedAt">): ActionRowState {
  switch (tool.state) {
    case "output-available":
      return "completed";
    case "output-error":
    case "output-denied":
      return "failed";
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
      return tool.startedAt === null ? "requested" : "running";
  }
}

const SANDBOX_ROW_STATE: Record<ActionState, ActionRowState> = {
  requested: "requested",
  running: "running",
  completed: "completed",
  failed: "failed",
};

/** Output as lines, dropping only a trailing empty line left by a final newline. */
function outputLines(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split("\n").filter((line, index, all) => line.length > 0 || index < all.length - 1);
}

export function ToolActionRow({
  tool,
  live,
}: {
  tool: ToolView;
  live?: LiveToolOutput | undefined;
}) {
  const facts: ActionFact[] = [{ label: "Tool", value: tool.runtimeName }];
  if (tool.durationMs !== null) {
    facts.push({ label: "Duration", value: formatDuration(tool.durationMs) });
  }
  if (tool.exitCode !== null) {
    facts.push({ label: "Exit code", value: String(tool.exitCode) });
  }
  if (tool.failure !== null) {
    facts.push({ label: "Error", value: tool.failure.errorText });
  }
  // The bridge sets the result's summary to the call's title, so the summary
  // is shown only when it adds to the label and there is no output.
  const printed = resultOutput(tool.result);
  if (tool.result !== null && printed === null && tool.result.summary !== tool.title) {
    facts.push({ label: "Result", value: tool.result.summary });
  }
  if (tool.approval !== null) {
    facts.push({ label: "Approval", value: tool.approval.state });
  }

  // The live buffer is stale once the call completes or fails.
  const liveText =
    tool.result === null && tool.failure === null && live !== undefined ? live.text : "";
  // The durable result is the record; the ephemeral `tool.output` tail is the
  // fallback. Only the tail can lose lines to a reconnect, so only its flag is shown.
  const committedLines = outputLines(
    printed === null ? tool.output.map((chunk) => chunk.text).join("") : printed.text,
  ).map((text) => ({ tag: null, text }));
  const dropped = printed === null ? tool.outputDropped : false;
  const liveLines =
    liveText.length === 0 ? [] : outputLines(liveText).map((text) => ({ tag: "live", text }));

  // Many calls print nothing, so the section appears only when there is output
  // or a gap to admit to; an empty section with a caution would train readers to ignore it.
  const showOutput = committedLines.length > 0 || liveLines.length > 0 || dropped;
  const failure = toolFailureCategory(tool);
  return (
    <ActionRow
      testId="row-tool"
      mark={CATEGORY_MARK[tool.category]}
      label={tool.title}
      state={toolRowState(tool)}
      meta={tool.durationMs === null ? undefined : formatDuration(tool.durationMs)}
      failure={
        failure === null
          ? null
          : {
              summary: FAILURE_SUMMARY[failure],
              tone: TONE_TEXT_CLASS[FAILURE_TONE[failure]],
            }
      }
      steps={[]}
      facts={facts}
      input={tool.input}
      output={
        showOutput
          ? {
              title: "Output",
              lines: [...committedLines, ...liveLines],
              dropped,
              cut: printed === null || printed.droppedChars === 0 ? null : printed.droppedChars,
            }
          : null
      }
    />
  );
}

/** The stream tag beside a relayed line; `null` leaves the column empty for a plain stdout line. */
const OUTPUT_TAG: Record<SandboxActionView["output"][number]["stream"], string | null> = {
  stdout: null,
  stderr: "stderr",
  system: "system",
  controller: "controller",
};

/**
 * Every step of the sandbox row with its offset from the first. Only a step
 * that ended the generation counts as failed; a running step reads as passed
 * once a later one arrives.
 */
export function sandboxSteps(action: SandboxActionView): readonly ActionStep[] {
  const offsets = stepOffsets(action.steps);
  const last = action.steps.length - 1;
  return action.steps.map((step, index) => ({
    label: step.label,
    detail: step.detail,
    offset: offsets[index] ?? "0s",
    state:
      index === last
        ? SANDBOX_ROW_STATE[action.state]
        : step.step === "failed" || step.step === "lost"
          ? "failed"
          : "completed",
  }));
}

export function SandboxActionRow({ action }: { action: SandboxActionView }) {
  const now = useNow(action.runningSince !== null && action.endedAt === null);
  const runningMs = sandboxRunningMs(action, now);
  const facts: ActionFact[] = [];
  if (action.providerSandboxId !== null) {
    facts.push({ label: "Sandbox", value: action.providerSandboxId });
  }
  if (runningMs !== null) {
    facts.push({
      label: action.endedAt === null ? "Running for" : "Ran for",
      value: formatElapsed(runningMs),
    });
  }
  if (action.explanation !== null) {
    facts.push({ label: "Detail", value: action.explanation });
  }
  // The label names the event, so a failed generation needs failure text beside it.
  const failure = SANDBOX_FAILURE_SUMMARY[action.step];
  return (
    <ActionRow
      testId="row-sandbox"
      // The sandbox prints a lot at start-up; it stays behind a fold until asked for.
      foldOutput
      // Animated until the agent runtime is ready; a running sandbox is steady state.
      live={sandboxInTransition(action)}
      // Before `sandbox.provisioning` names a provider, the row does not claim Modal.
      mark={PROVIDER_MARK[action.provider ?? "fake"]}
      label={action.label}
      state={SANDBOX_ROW_STATE[action.state]}
      failure={failure === null ? null : { summary: failure, tone: TONE_TEXT_CLASS.danger }}
      steps={sandboxSteps(action)}
      facts={facts}
      input={null}
      output={
        action.output.length === 0
          ? null
          : {
              title: "Sandbox output",
              lines: action.output.map((line) => ({
                tag: OUTPUT_TAG[line.stream],
                text: line.text,
              })),
              dropped: false,
            }
      }
    />
  );
}

export { artifactFileName } from "./artifact-download";

/**
 * A large artifact is summarised, never inlined (record 13); the link downloads
 * it through the Worker, which serves only the session's owner. Any failure
 * reads "Artifact unavailable" rather than throwing.
 */
export function ArtifactRow({
  sessionId,
  artifactId,
  artifact,
}: {
  sessionId: string | null;
  artifactId: string;
  artifact: ArtifactView | undefined;
}) {
  const { busy, unavailable, download } = useArtifactDownload(
    sessionId,
    artifactId,
    artifact?.ref?.label ?? null,
  );

  return (
    <div data-testid="row-artifact">
      <QuietRow icon={<FileText className="size-3.5" aria-hidden="true" />}>
        {artifact?.kind ?? "artifact"} · {artifact?.contentType ?? artifactId}
        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          className="ml-2 underline underline-offset-2 hover:text-text disabled:opacity-60"
        >
          Download
        </button>
        {unavailable ? (
          <span role="status" data-testid="artifact-unavailable" className="ml-2 text-danger">
            Artifact unavailable
          </span>
        ) : null}
      </QuietRow>
    </div>
  );
}

export function TimelineRow({
  view,
  item,
  sessionId = null,
  onReview,
  onPolicyAnswer,
  onApprovalAnswer,
  onOpenAgent,
  branch,
  decisionsAbove = false,
  pauseLinksToKeys,
}: {
  view: SessionView;
  item: TimelineItem;
  /** What a policy card needs to ask for a branch name; absent on read-only surfaces. */
  branch?: BranchChoice | undefined;
  /** The screen draws the pending policy question above the composer; the row then draws none. */
  decisionsAbove?: boolean | undefined;
  /** Whether the pause the run is stopped on links to Model providers; absent, a rejected key does. */
  pauseLinksToKeys?: boolean | undefined;
  /** The session the screen is showing; the view's own id is the fallback. */
  sessionId?: string | null;
  /** Opens the review panel: a change card's Review, or an outcome's checks. */
  onReview?: ((target: ReviewTarget) => void) | undefined;
  /** The user's answer to a policy confirmation card. */
  onPolicyAnswer?: AnswerHandler<PolicyAnswer> | undefined;
  /** The user's answer to an approval card; returns whether it was sent, so an unsent click may repeat. */
  onApprovalAnswer?: AnswerHandler<ApprovalAnswer> | undefined;
  /** Opens one subagent in the side panel; absent on read-only surfaces. */
  onOpenAgent?: ((agentId: string) => void) | undefined;
}) {
  switch (item.kind) {
    case "message": {
      const message = view.messages.get(item.messageId);
      return message === undefined ? null : (
        <MessageRow
          message={message}
          live={view.live.messages.get(item.messageId)}
          sessionId={sessionId ?? view.sessionId}
        />
      );
    }
    case "tool": {
      const agent = agentsByCall(view).get(item.toolCallId);
      if (agent !== undefined) {
        return <AgentLaunchRow view={view} agent={agent} onOpen={onOpenAgent} />;
      }
      const tool = view.tools.get(item.toolCallId);
      return tool === undefined ? null : (
        <ToolActionRow tool={tool} live={view.live.toolOutput.get(item.toolCallId)} />
      );
    }
    case "sandbox": {
      const action = view.sandboxActions.get(item.generation);
      return action === undefined ? null : <SandboxActionRow action={action} />;
    }
    case "progress": {
      const step = view.progress.get(item.stepId);
      return (
        <div data-testid="row-progress">
          <QuietRow icon={<CircleDot className="size-3.5" aria-hidden="true" />}>
            {step?.label ?? item.stepId}
          </QuietRow>
        </div>
      );
    }
    case "plan": {
      const plan = view.plans.get(item.planId);
      const done = plan?.steps.filter((step) => step.status === "complete").length ?? 0;
      const total = plan?.steps.length ?? 0;
      return (
        <div data-testid="row-plan">
          <QuietRow icon={<ListChecks className="size-3.5" aria-hidden="true" />}>
            Plan {item.change} · {done} of {total} steps
          </QuietRow>
        </div>
      );
    }
    case "secrets":
      return <SecretsDisclosedRow view={view} />;
    case "secrets_supplied":
      return <SecretsSuppliedRow names={item.names} delivered={item.delivered} />;
    case "approval": {
      // The decision stays in the log under its card; the rail's "An approval is waiting" points here.
      return (
        <ApprovalRow
          view={view}
          approvalId={item.approvalId}
          change={item.change}
          onAnswer={onApprovalAnswer}
        />
      );
    }
    case "check":
      return (
        <CheckRow view={view} checkId={item.checkId} sessionId={sessionId ?? view.sessionId} />
      );
    case "verification": {
      // The summary's proposed outcome is the sandbox's claim, which the object
      // may refuse, so this row shows only counts.
      const required = view.verification.summaries.get(item.runId)?.required;
      return (
        <div data-testid="row-verification">
          <QuietRow icon={<Check className="size-3.5" aria-hidden="true" />}>
            Checks finished
            {required === undefined || required.total === 0
              ? ""
              : ` · ${required.passed} of ${required.total} required passed`}
          </QuietRow>
        </div>
      );
    }
    case "changes": {
      // The fold emits this item with the run's first turn diff; without one it draws nothing.
      const diff = view.git.turnDiffs.get(item.runId);
      return diff === undefined ? null : (
        <ChangeCard
          runId={item.runId}
          diff={diff}
          onReview={
            onReview === undefined
              ? undefined
              : (runId, path) =>
                  onReview({
                    tab: "review",
                    scope: "turn",
                    runId,
                    ...(path === undefined ? {} : { path }),
                  })
          }
        />
      );
    }
    case "policy": {
      const change = view.policy.changes.find((entry) => entry.sequence === item.sequence);
      if (change === undefined) {
        return null;
      }
      // The pending question is asked above the composer; the timeline keeps what was decided.
      if (decisionsAbove && view.policy.pendingProposal?.proposalId === change.proposalId) {
        return null;
      }
      return <PolicyRow view={view} change={change} onAnswer={onPolicyAnswer} branch={branch} />;
    }
    case "commit":
      return (
        <div data-testid="row-commit">
          <QuietRow icon={<GitCommitHorizontal className="size-3.5" aria-hidden="true" />}>
            Commit <span className="font-mono text-[12px]">{item.sha.slice(0, 7)}</span>
          </QuietRow>
        </div>
      );
    case "push": {
      // For a withheld checkpoint this message is the only place the files holding a secret are named.
      const failure =
        item.change === "failed" ? view.git.pushes.get(item.pushId)?.failure : undefined;
      return (
        <div data-testid="row-push">
          <QuietRow icon={<Upload className="size-3.5" aria-hidden="true" />}>
            Push {item.change}
          </QuietRow>
          {failure?.message ? (
            <p className="-mt-1 break-words pb-1.5 pl-[22px] text-[13px] text-muted-foreground">
              {failure.message}
              {failure.category === "non_fast_forward" ? ` ${NON_FAST_FORWARD_HINT}` : ""}
            </p>
          ) : null}
        </div>
      );
    }
    case "pull_request":
      return (
        <div data-testid="row-pull-request">
          <QuietRow icon={<GitPullRequest className="size-3.5" aria-hidden="true" />}>
            Pull request #{item.number} {item.change}
          </QuietRow>
        </div>
      );
    case "artifact":
      // A check's log is reached from its check row and the Tests view instead.
      return isVerificationLog(view, item) ? null : (
        <ArtifactRow
          sessionId={sessionId ?? view.sessionId}
          artifactId={item.artifactId}
          artifact={view.artifacts.get(item.artifactId)}
        />
      );
    case "review":
      return (
        <div data-testid="row-review">
          <QuietRow icon={<GitPullRequest className="size-3.5" aria-hidden="true" />}>
            Review {item.change}
          </QuietRow>
        </div>
      );
    case "question":
      return <QuestionRow view={view} questionId={item.questionId} />;
    case "run": {
      const failure = modelFailureOfRow(item);
      if (failure !== null) {
        return (
          <PausedRow view={view} item={item} failure={failure} linksToKeys={pauseLinksToKeys} />
        );
      }
      return isRunOutcome(item.transition) ? (
        <RunOutcomeRow
          view={view}
          runId={item.runId}
          outcome={item.transition}
          onOpenTests={
            onReview === undefined
              ? undefined
              : (runId) => onReview({ tab: "tests", scope: "turn", runId })
          }
        />
      ) : (
        <div data-testid="row-run">
          <QuietRow icon={<CircleDot className="size-3.5" aria-hidden="true" />}>
            Run {item.transition}
          </QuietRow>
        </div>
      );
    }
  }
}

/** A model as the picker names it, or its id read plainly where the catalog does not list it. */
function modelNameOf(
  catalog: ModelCatalog | undefined,
  model: Pick<NonNullable<RunView["model"]>, "provider" | "modelId">,
): string {
  const rows = (catalog as Readonly<Record<string, ModelCatalog[ModelProvider] | undefined>>)?.[
    model.provider
  ];
  const listed = rows?.find((row) => row.modelId === model.modelId);
  return listed === undefined ? displayModelName(model.modelId) : shortModelName(listed.name);
}

/** Where the owner changed the session's model: the run after it runs on the model named. */
export function ModelChangeRow({
  view,
  runId,
  catalog,
}: {
  view: SessionView;
  runId: RunView["runId"];
  catalog?: ModelCatalog | undefined;
}) {
  const run = view.runs.get(runId);
  const model = run?.model ?? null;
  if (run === undefined || model === null) {
    return null;
  }
  const before =
    run.continuesRunId === null ? null : (view.runs.get(run.continuesRunId)?.model ?? null);
  const to = modelNameOf(catalog, model);
  return (
    <div data-testid="row-model-change">
      <QuietRow icon={<ArrowLeftRight className="size-3.5" aria-hidden="true" />}>
        {before === null
          ? `Model changed to ${to}`
          : `Model changed from ${modelNameOf(catalog, before)} to ${to}`}
      </QuietRow>
    </div>
  );
}

/** The call that asked a question; its question row stands in for its tool row. */
function isQuestionCall(view: SessionView, item: TimelineItem): boolean {
  if (item.kind !== "tool") {
    return false;
  }
  for (const question of view.questions.values()) {
    if (question.toolCallId === item.toolCallId) {
      return true;
    }
  }
  return false;
}

/** An artifact a verification check uploaded, which gets no timeline row of its own. */
function isVerificationLog(view: SessionView, item: TimelineItem): boolean {
  return (
    item.kind === "artifact" && view.artifacts.get(item.artifactId)?.producer === "verification"
  );
}

/** The run a group of work belongs to, when the view knows it. */
function runOfUnit(view: SessionView, items: readonly TimelineItem[]): RunView | undefined {
  const runId = runOfActivity(view, items);
  return runId === null ? undefined : view.runs.get(runId);
}

const RUN_OUTCOME_SET: ReadonlySet<string> = new Set<RunOutcome>(RUN_OUTCOMES);

function isRunOutcome(transition: string): transition is RunOutcome {
  return RUN_OUTCOME_SET.has(transition);
}

export function Timeline({
  view,
  sessionId = null,
  onReview,
  onPolicyAnswer,
  onApprovalAnswer,
  onOpenAgent,
  onOpenAgents,
  contextRef,
  branch,
  decisionsAbove = false,
  catalog,
  pauseLinksToKeys,
}: {
  view: SessionView;
  sessionId?: string | null;
  /** Every provider's models, so a change of model is named as the picker names it. */
  catalog?: ModelCatalog | undefined;
  branch?: BranchChoice | undefined;
  /** The pending policy question is asked above the composer, not here. */
  decisionsAbove?: boolean | undefined;
  /**
   * Whether the model-failure pause the run is stopped on links to Model
   * providers, as the note under the composer decides it. Absent on a surface
   * that does not know the key's state; a rejected key then links.
   */
  pauseLinksToKeys?: boolean | undefined;
  onReview?: ((target: ReviewTarget) => void) | undefined;
  onPolicyAnswer?: AnswerHandler<PolicyAnswer> | undefined;
  /** Whether the decision left on the socket; a click that sent nothing may be repeated. */
  onApprovalAnswer?: AnswerHandler<ApprovalAnswer> | undefined;
  /** The scroll container's context, so the screen can keep the reading position across a reflow. */
  contextRef?: Ref<StickToBottomContext> | undefined;
  /** Opens one subagent in the side panel. */
  onOpenAgent?: ((agentId: string) => void) | undefined;
  /** Opens the side panel's Agents view, from the running-agents pill. */
  onOpenAgents?: (() => void) | undefined;
}) {
  const running = runningAgents(view).length;
  const units = groupTimeline(
    view,
    view.timeline.filter((item) => !isVerificationLog(view, item) && !isQuestionCall(view, item)),
  );
  // Only the newest unit of a running run is live: the line that says what the
  // agent is doing now.
  const lastUnit = units.at(-1);
  const liveKey =
    lastUnit?.kind === "activity" && runInProgress(runOfUnit(view, lastUnit.items))
      ? lastUnit.key
      : null;
  const agentsPill = (
    <RunningAgentsPill count={running} label={runningAgentsLabel(running)} onOpen={onOpenAgents} />
  );
  return (
    <Conversation className="flex-1" {...(contextRef === undefined ? {} : { contextRef })}>
      <ConversationContent className="mx-auto flex max-w-[720px] flex-col gap-1 px-6 py-5">
        {units.map((unit) => {
          if (unit.kind === "item") {
            return (
              // The key lets the screen find the first visible row again after a reflow.
              <div key={unit.key} data-timeline-key={unit.key} className="min-w-0">
                <TimelineRow
                  view={view}
                  item={unit.item}
                  sessionId={sessionId}
                  onReview={onReview}
                  onPolicyAnswer={onPolicyAnswer}
                  onApprovalAnswer={onApprovalAnswer}
                  onOpenAgent={onOpenAgent}
                  branch={branch}
                  decisionsAbove={decisionsAbove}
                  pauseLinksToKeys={pauseLinksToKeys}
                />
              </div>
            );
          }
          if (unit.kind === "copy") {
            return (
              <div key={unit.key} data-timeline-key={unit.key} className="min-w-0">
                <CopyResponse text={unit.text} />
              </div>
            );
          }
          if (unit.kind === "model_change") {
            return (
              <div key={unit.key} data-timeline-key={unit.key} className="min-w-0">
                <ModelChangeRow view={view} runId={unit.runId} catalog={catalog} />
              </div>
            );
          }
          const live = unit.key === liveKey;
          return (
            <div key={unit.key} data-timeline-key={unit.key} className="min-w-0">
              <ActivityGroup
                view={view}
                items={unit.items}
                phase={unit.phase}
                live={live}
                // The running subagents are named beside what the agent is doing now.
                aside={live && running > 0 ? agentsPill : undefined}
              >
                {unit.items.map((item) => (
                  <div key={itemKey(item)} data-timeline-key={itemKey(item)} className="min-w-0">
                    <TimelineRow
                      view={view}
                      item={item}
                      sessionId={sessionId}
                      onReview={onReview}
                      onPolicyAnswer={onPolicyAnswer}
                      onApprovalAnswer={onApprovalAnswer}
                      branch={branch}
                      decisionsAbove={decisionsAbove}
                    />
                  </div>
                ))}
              </ActivityGroup>
            </div>
          );
        })}
        {/* With no such line to stand beside, the pill takes one of its own. */}
        {running > 0 && liveKey === null ? (
          <div className="pt-2" data-testid="running-agents">
            {agentsPill}
          </div>
        ) : null}
      </ConversationContent>
    </Conversation>
  );
}
