import type { ArtifactRef, CommandId, EffortLevel, ModelRecord, RunView } from "@oncue/protocol";
import { agentStatusOf, BRANCH_PREFIX, RUN_OUTCOMES } from "@oncue/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { ApprovalAnswer } from "@/features/approvals/ApprovalCard";
import { harnessAsksPermission } from "@/features/approvals/approval-modes";
import { PermissionCard } from "@/features/approvals/PermissionCard";
import { useSessionApprovals } from "@/features/approvals/use-session-approvals";
import type { ReviewTarget } from "@/features/diff/review-model";
import { SessionMenu } from "@/features/home/SessionMenu";
import { branchNameOf } from "@/features/policy/BranchNameField";
import { type PolicyAnswer, PolicyRow } from "@/features/policy/PolicyCard";
import {
  type QuestionAnswer,
  QuestionCard,
  questionAnnouncement,
} from "@/features/questions/QuestionCard";
import type { BranchMode } from "@/lib/api/sessions";
import { keepSandboxAlive, stopSandbox as stopSandboxRequest } from "@/lib/api/sessions";
import type {
  InactiveModelConnection,
  ModelCatalog,
  ModelConnectionSummary,
  RuntimeSummary,
} from "@/lib/api/setup";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { cn } from "@/lib/utils";
import { SessionNotFound } from "@/routes/NotFound";
import { ArchivedNotice } from "./ArchivedNotice";
import { namedBranch } from "./branch";
import { suggestBranch } from "./branch-suggestion";
import { Composer, type SubmitOptions, type SubmitResult } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { ContextRail, ModelConnectionsLink, type PolicySwitch } from "./ContextRail";
import {
  approvalCommand,
  asProposalId,
  cancelRunCommand,
  followUpCommand,
  type PolicyPayload,
  policyCommand,
  startRunCommand,
} from "./command-builders";
import {
  continueNeedsNewKey,
  deliveryFor,
  intentFor,
  sandboxIsLive,
  WAIT_GUIDANCE,
  waitReason,
} from "./composer-state";
import { catalogOfConnections, contextMeterOf } from "./context-meter";
import { type ModelChoice, modelRowsOf } from "./ModelPicker";
import {
  KEY_GUIDANCE,
  type ModelFailure,
  modelFailureNote,
  modelFailureNoteText,
  pausedModelFailureOf,
  runConnectionStateOf,
} from "./model-failure";
import {
  canSwitchModel,
  isAnotherModel,
  type ModelSwitch,
  switchRecord,
  switchRowOf,
  switchSummary,
} from "./model-switch";
import { SessionHeader } from "./SessionHeader";
import {
  type KeepAliveOutcome,
  type PanelTab,
  SessionPanel,
  type StopOutcome,
} from "./SessionPanel";
import { currentSandboxAction, sandboxPhaseOf } from "./sandbox-time";
import { captureScroll, restoreScroll, type ScrollSnapshot } from "./scroll-anchor";
import { Timeline } from "./Timeline";
import {
  ANSWER_TIMEOUT_MS,
  type CommandOutcome,
  outcomeProblem,
  useCommands,
} from "./use-commands";
import type { OutgoingCommand, SocketFactory } from "./use-session";
import { useSession } from "./use-session";

export { ANSWER_TIMEOUT_MS } from "./use-commands";

/** Id of the note saying why the run stopped or takes no message now; the message box uses it as its description. */
const RUN_NOTE_ID = "composer-run-note";
/** Id of the note about the last send, or the connection a send would wait for. */
const SEND_NOTE_ID = "composer-send-note";

/**
 * What became of the last send, or, with nothing to report, that the
 * connection is down and a message sent now waits for it. A held message
 * can be withdrawn until it leaves.
 */
function SendNotice({
  notice,
  disconnected,
  onWithdraw,
}: {
  notice: ComposerNotice | null;
  disconnected: boolean;
  onWithdraw: () => void;
}) {
  if (notice === null && !disconnected) {
    return null;
  }
  const tone =
    notice !== null && notice.kind !== "queued" ? "text-danger" : "text-muted-foreground";
  return (
    <div
      id={SEND_NOTE_ID}
      role="status"
      data-testid="composer-send-notice"
      data-kind={notice?.kind ?? "disconnected"}
      className={cn("mt-2 flex flex-wrap items-center gap-x-2 px-1 text-[13px]", tone)}
    >
      <span>{noticeText(notice)}</span>
      {notice?.kind === "queued" ? (
        <button
          type="button"
          onClick={onWithdraw}
          data-testid="composer-withdraw"
          className="rounded-md px-1.5 py-0.5 text-text underline underline-offset-2 hover:bg-hover"
        >
          Don't send
        </button>
      ) : null}
    </div>
  );
}

function noticeText(notice: ComposerNotice | null): string {
  switch (notice?.kind) {
    case undefined:
      return "Reconnecting. A message you send now goes out once the connection is back.";
    case "queued":
      return "Not connected. Your message will send when OnCue reconnects.";
    case "unanswered":
      return "OnCue didn't confirm your message. It is still in the box: send again to retry, and it will not arrive twice.";
    case "not_ready":
      return "This session is still loading, so the message was not sent. Try again in a moment.";
    case "problem":
      return notice.text;
  }
}

/** The stop request as the panel's dialog reports it. Pure, so the panel test can drive it. */
export async function stopSandboxOutcome(sessionId: string): Promise<StopOutcome> {
  const result = await stopSandboxRequest(sessionId);
  switch (result.kind) {
    case "stopped":
      return { ok: true };
    case "stopping":
      // Accepted: the object finishes the stop whether this click began it or joined one.
      return { ok: true, notice: "Stopping the sandbox…" };
    case "not_running":
      return { ok: false, message: "There is no running sandbox to stop." };
    case "denied":
      return { ok: false, message: "You're signed out. Sign in again to stop the sandbox." };
    case "failed":
      return { ok: false, message: result.message };
    case "unreachable":
      return { ok: false, message: "OnCue couldn't reach the server. Try again." };
  }
}

/** The keep-alive request as the panel reports it. */
export async function keepAliveOutcome(sessionId: string): Promise<KeepAliveOutcome> {
  const result = await keepSandboxAlive(sessionId);
  switch (result.kind) {
    case "kept":
      return { ok: true, expiresAt: result.expiresAt };
    case "not_running":
      return { ok: false, message: "The sandbox is not running." };
    case "denied":
      return {
        ok: false,
        message: "You're signed out. Sign in again to keep the sandbox running.",
      };
    case "unreachable":
      return { ok: false, message: "OnCue couldn't reach the server. Try again." };
  }
}

/**
 * How long an accepted stop may leave its subagent running before the button
 * comes back. The bridge does not report an abort that failed, and a second
 * stop makes it try again.
 */
export const AGENT_STOP_WAIT_MS = 15_000;

/** What the subagent's row says when that wait runs out. */
export const AGENT_STILL_RUNNING = "It is still running. Try again.";

/** What the rail's Continue button sends, as an ordinary follow-up the timeline shows. */
export const CONTINUE_MESSAGE = "Continue from the last checkpoint.";

/** How a checks-only run is labelled on the timeline (record 14). */
export const RUN_CHECKS_MESSAGE = "Run the repository's checks.";

/**
 * A `run.start` that runs the repository's checks without prompting the model
 * (record 14). Offered only once the latest run has ended and its model is
 * still usable, since the checks continue that run's conversation.
 */
export function checksRequest(
  run: RunView | null,
  commandId: string,
  runModelUsable = true,
): OutgoingCommand<"run.start"> | null {
  if (run === null || run.model === null || run.outcome === null || !runModelUsable) {
    return null;
  }
  return startRunCommand({
    commandId,
    text: RUN_CHECKS_MESSAGE,
    model: run.model,
    continuesRunId: run.runId,
    checksOnly: true,
  });
}

const NO_MODEL_CONNECTIONS: readonly ModelConnectionSummary[] = [];

/** The workspace's connections as the agent chip lists them. */
function modelChoicesOf(connections: readonly ModelConnectionSummary[]): readonly ModelChoice[] {
  return connections.map((connection) => ({
    id: connection.modelConnectionId,
    label: connection.label,
    provider: connection.provider,
    modelId: connection.modelId,
    models: connection.models,
  }));
}
const NO_INACTIVE_CONNECTIONS: readonly InactiveModelConnection[] = [];

/**
 * The one note under the composer about the run itself: a model failure it
 * is paused on, a key its next message needs, or a sandbox it must wait for.
 */
type RunNote = {
  readonly testId: "composer-model-failure" | "composer-model-unavailable" | "composer-wait";
  readonly text: string;
  /** Whether the way forward is in Settings, Model providers. */
  readonly linksToKeys: boolean;
};
const NO_RUNTIMES: readonly RuntimeSummary[] = [];

/**
 * The command a composer message becomes. Pure, so the send and the label
 * beside the button both read `intentFor(run, sandboxLive)` and cannot disagree.
 * An ended run gets a `run.start` on the same model; a live run gets a
 * `run.follow_up`. With no run yet (before `run.queued` replays) there is no
 * model to continue on, so the message is refused and the draft stays.
 */
export function outgoingMessage(
  run: RunView | null,
  text: string,
  commandId: string,
  sandboxLive: boolean,
  runModelUsable = true,
  skipRequiredChecks = false,
  /** The next run's effort; `undefined` keeps the run's own. A steer never carries one. */
  effort?: EffortLevel | null,
  /** Uploaded attachments; the object claims them and records its own copy of each. */
  attachments: readonly ArtifactRef[] = [],
  /**
   * The model the owner confirmed for the next run (record 15), or null to
   * keep the run's own. Sent only where a change is allowed (`canSwitchModel`).
   */
  nextModel: ModelRecord | null = null,
): OutgoingCommand | null {
  if (nextModel !== null && run !== null && canSwitchModel(run)) {
    // A run on another model, continuing this one; the object ends a paused
    // or interrupted run first and checks the model against its own rows.
    return startRunCommand({
      commandId,
      text,
      model: nextModel,
      continuesRunId: run.runId,
      attachments,
      skipRequiredChecks,
    });
  }
  const intent = intentFor(run, sandboxLive, runModelUsable);
  if (intent === "wait") {
    return null;
  }
  if (intent === "start_next") {
    if (run === null || run.model === null) {
      return null;
    }
    return startRunCommand({
      commandId,
      text,
      // A fresh run uses the effort chosen now.
      model: effort === undefined ? run.model : { ...run.model, effort },
      continuesRunId: run.runId,
      attachments,
      skipRequiredChecks,
    });
  }
  // `intentFor` answers `steer`, `resume`, or `run_next` only for a live run.
  const live = run as RunView;
  return followUpCommand({
    commandId,
    run: live,
    text,
    attachments,
    delivery: deliveryFor(intent),
    // A queued message may change the next run's effort; a steer never
    // changes the running run's.
    ...(intent === "run_next" && effort !== undefined ? { effort } : {}),
    skipRequiredChecks,
  });
}

/** A copy of `map` without `key`, or `map` itself when it has none. */
function withoutKey<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) {
    return map;
  }
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** The problem shown under the composer, one at a time. */
type ComposerNotice =
  | { readonly kind: "queued"; readonly commandId: string }
  | { readonly kind: "unanswered" }
  | { readonly kind: "not_ready" }
  | { readonly kind: "problem"; readonly text: string };

export type SessionScreenProps = {
  sessionId: string;
  repository?: string;
  /** The branch the control plane created for this session, shown until `run.started` names it. */
  taskBranch?: string | null;
  /** The branch the session started from; null for the default branch or an older session. */
  baseBranch?: string | null;
  /** `existing_branch` when the session works directly on `taskBranch` and pushes there. */
  branchMode?: BranchMode;
  /** The workspace's model connections, so the model control can name the one this session's runs use. */
  modelConnections?: readonly ModelConnectionSummary[];
  /**
   * The workspace's keys that stopped working. A run on one of them can
   * continue once its key is replaced; a run on a connection in neither list
   * cannot.
   */
  inactiveModelConnections?: readonly InactiveModelConnection[] | undefined;
  /**
   * Reads the connections again. They came with the page, so a run that pauses
   * on its key, or waits on one being replaced elsewhere, asks for a fresh read.
   */
  onRefreshConnections?: (() => unknown) | undefined;
  /** Counts the connection reads applied so far, so the screen can tell one made after a pause. */
  connectionsRevision?: number;
  /** The allowed harnesses; with more than one, the composer names this session's, read-only. */
  runtimes?: readonly RuntimeSummary[];
  /**
   * Every provider's models, for the context gauge's window and prices.
   * Absent, the connections' own catalogs stand in.
   */
  catalog?: ModelCatalog | undefined;
  runtime?: string | null;
  createSocket?: SocketFactory;
  /** Overrides the default send over the session socket; used only by tests. */
  onSubmit?: (
    text: string,
    commandId: string,
    modelConnectionId: string | null,
    options?: SubmitOptions,
  ) => Promise<boolean> | boolean;
  /** Stops the session's sandbox. Defaults to the real request; the harness stubs it. */
  onStopSandbox?: () => Promise<StopOutcome>;
  /** Keeps the session's sandbox running for an hour. Defaults to the real request. */
  onKeepSandboxAlive?: () => Promise<KeepAliveOutcome>;
  /**
   * Called when the current run or its state changes, so the sidebar can
   * refresh and mark a run that ended on screen as seen. `null` with no run.
   */
  onRunChange?: (run: { readonly runId: string; readonly ended: boolean } | null) => void;
  /** An archived session is read-only: the timeline stays, the composer gives way to Unarchive. */
  archived?: boolean;
  /** The session's title, for its options menu. */
  title?: string;
  /**
   * Opens with the session details pinned. A chat in the app always opens
   * with them unpinned; only the dev harness and tests pass this.
   */
  railPinnedAtStart?: boolean;
};

export function SessionScreen({
  sessionId,
  repository = "acme/oncue",
  taskBranch = null,
  baseBranch = null,
  branchMode = "new_branch",
  modelConnections = NO_MODEL_CONNECTIONS,
  inactiveModelConnections = NO_INACTIVE_CONNECTIONS,
  onRefreshConnections,
  connectionsRevision = 0,
  runtimes = NO_RUNTIMES,
  catalog,
  runtime = null,
  createSocket,
  onSubmit,
  onStopSandbox,
  onKeepSandboxAlive,
  onRunChange,
  archived = false,
  title = "Untitled session",
  railPinnedAtStart = false,
}: SessionScreenProps) {
  const { view, connection, denied, sendCommand, cancelQueued } = useSession(
    sessionId,
    createSocket ? { createSocket } : {},
  );
  const currentRunId = view.run?.runId ?? null;
  const currentRunState = view.run?.state ?? null;
  useEffect(() => {
    onRunChange?.(
      currentRunId === null
        ? null
        : {
            runId: currentRunId,
            ended:
              currentRunState !== null &&
              (RUN_OUTCOMES as readonly string[]).includes(currentRunState),
          },
    );
  }, [currentRunId, currentRunState, onRunChange]);
  // Every chat starts with the session details unpinned; the person pins them from the header.
  const [railPinned, setRailPinned] = useState(railPinnedAtStart);
  const [side, setSideState] = useState<SideState | null>(null);
  const sandbox = currentSandboxAction(view);

  // Opening or closing the side panel reflows the timeline, so the reading
  // position is saved before the change and restored after (`scroll-anchor.ts`).
  const conversation = useRef<StickToBottomContext | null>(null);
  const sideRef = useRef<SideState | null>(null);
  const pendingScroll = useRef<ScrollSnapshot | null>(null);
  const [layoutChanges, setLayoutChanges] = useState(0);
  const setSide = useCallback((next: SideState | null) => {
    // Switching tabs inside the open panel keeps its width, so only open and close reflow.
    if ((sideRef.current === null) !== (next === null)) {
      const context = conversation.current;
      pendingScroll.current = captureScroll(
        context?.scrollRef.current,
        context?.isAtBottom ?? false,
      );
      setLayoutChanges((count) => count + 1);
    }
    sideRef.current = next;
    setSideState(next);
  }, []);
  useLayoutEffect(() => {
    const snapshot = pendingScroll.current;
    if (layoutChanges === 0 || snapshot === null) {
      return;
    }
    pendingScroll.current = null;
    const restore = () => {
      const context = conversation.current;
      restoreScroll(context?.scrollRef.current, snapshot, () => {
        void context?.scrollToBottom("instant");
      });
    };
    restore();
    // The split applies its sizes after this commit, so the reflow can land a
    // frame later; restoring again is a no-op when nothing moved.
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [layoutChanges]);

  /** Brings a tab to the front, opening it (and the panel) first if needed. */
  const openPanel = useCallback(
    (tab: PanelTab) => {
      const current = sideRef.current;
      const alreadyOpen = current?.open.includes(tab) === true;
      setSide({
        open: current === null ? [tab] : alreadyOpen ? current.open : [...current.open, tab],
        active: tab,
        review: current?.review ?? DEFAULT_REVIEW,
        // Agents opened by name starts on its list; switching back to its open
        // tab keeps the subagent it was on.
        agent: tab === "agents" && !alreadyOpen ? null : (current?.agent ?? null),
      });
    },
    [setSide],
  );
  /**
   * Opens the Agents view on one subagent's detail, or on the list with
   * `null`: the timeline's subagent row, and the running-agents pill.
   */
  const openAgent = useCallback(
    (agentId: string | null) => {
      const current = sideRef.current;
      setSide({
        open:
          current === null
            ? ["agents"]
            : current.open.includes("agents")
              ? current.open
              : [...current.open, "agents"],
        active: "agents",
        review: current?.review ?? DEFAULT_REVIEW,
        agent: agentId,
      });
    },
    [setSide],
  );
  const openAgents = useCallback(() => openAgent(null), [openAgent]);
  // Finished subagents the reader cleared from the Agents view, for this screen.
  const [clearedAgents, setClearedAgents] = useState<ReadonlySet<string>>(() => new Set());
  const clearFinishedAgents = useCallback((agentIds: readonly string[]) => {
    setClearedAgents((current) => new Set([...current, ...agentIds]));
  }, []);
  /** Opens the Review tab on a target: a change card's turn, the rail's whole session, an outcome's Tests. */
  const openReview = useCallback(
    (target: ReviewTarget) => {
      const current = sideRef.current;
      setSide({
        open:
          current === null
            ? ["review"]
            : current.open.includes("review")
              ? current.open
              : [...current.open, "review"],
        active: "review",
        review: target,
        agent: current?.agent ?? null,
      });
    },
    [setSide],
  );
  const closeTab = useCallback(
    (tab: PanelTab) => {
      const current = sideRef.current;
      if (current === null) {
        return;
      }
      const open = current.open.filter((entry) => entry !== tab);
      const last = open.at(-1);
      // A closed Agents tab forgets which subagent it was on.
      const agent = tab === "agents" ? null : (current.agent ?? null);
      // Closing the last tab goes back to the list of views; only the
      // panel's own close hides it.
      if (last === undefined) {
        setSide({ ...current, open: [], active: null, agent });
        return;
      }
      const active = current.active === tab ? last : current.active;
      setSide({ ...current, open, active, agent });
    },
    [setSide],
  );
  // The header's toggle opens the panel on its list of views, never on a
  // view the reader did not choose.
  const togglePanel = useCallback(() => {
    if (sideRef.current === null) {
      setSide({ open: [], active: null, review: DEFAULT_REVIEW });
    } else {
      setSide(null);
    }
  }, [setSide]);
  const stop = useCallback(
    () => (onStopSandbox ?? (() => stopSandboxOutcome(sessionId)))(),
    [onStopSandbox, sessionId],
  );
  const keepAlive = useCallback(
    () => (onKeepSandboxAlive ?? (() => keepAliveOutcome(sessionId)))(),
    [onKeepSandboxAlive, sessionId],
  );
  // The header tells a plain disconnect from "offline with unsent input" (record 13).
  const [hasUnsentInput, setHasUnsentInput] = useState(false);
  const run = view.run;
  const sandboxLive = sandboxIsLive(view.sandbox.state);
  // A run whose connection is no longer active cannot be continued; the object would refuse it.
  const runConnection = runConnectionStateOf(
    run?.model?.modelConnectionId ?? null,
    modelConnections,
    inactiveModelConnections,
  );
  const runModelUsable = runConnection === "active";
  // The connections on hand were read before this pause was seen, and a
  // rejected key changes them. Until a read made since arrives, the screen
  // says nothing about the key's state.
  const modelPause = pausedModelFailureOf(run);
  const [pauseSeen, setPauseSeen] = useState<{
    readonly pause: ModelFailure;
    readonly revision: number;
  } | null>(null);
  if (modelPause !== null && pauseSeen?.pause !== modelPause) {
    setPauseSeen({ pause: modelPause, revision: connectionsRevision });
  }
  const keyStateKnown =
    modelPause === null ||
    onRefreshConnections === undefined ||
    (pauseSeen?.pause === modelPause && connectionsRevision > pauseSeen.revision);
  // Read again at the pause, and on every return to the tab while the run
  // waits on a key the person replaces in Settings or another tab.
  useRefreshOnReturn(
    !keyStateKnown || runConnection === "replaceable",
    onRefreshConnections,
    modelPause,
  );
  // The model the owner chose for the next run (record 15). It belongs to
  // the run it was chosen against.
  const [nextModel, setNextModel] = useState<{
    readonly runId: string;
    readonly choice: ModelSwitch;
  } | null>(null);
  const modelSwitchable = !archived && canSwitchModel(run);
  const modelRows = useMemo(
    () => modelRowsOf(modelChoicesOf(modelConnections)),
    [modelConnections],
  );
  // A choice lasts until its run is followed by another, or its key leaves the list.
  const switchRow =
    modelSwitchable && nextModel !== null && nextModel.runId === run?.runId
      ? switchRowOf(modelRows, nextModel.choice)
      : undefined;
  const switching = switchRow !== undefined && switchRecord(switchRow, null) !== null;
  // Whether any active connection offers a model a change could name.
  const canOfferAnotherModel = modelRows.some((row) => switchRecord(row, null) !== null);
  const intent = switching ? "start_next" : intentFor(run, sandboxLive, runModelUsable);
  // No send is offered that the object would refuse; the composer says why.
  const needsNewKey = !switching && continueNeedsNewKey(run, sandboxLive, runModelUsable);
  // `run.cancel` is allowed from every non-terminal state (record 10), and
  // `ending` is set only by a terminal outcome.
  const canCancelRun = run !== null && run.ending === null;

  const modelChoices = useMemo(() => modelChoicesOf(modelConnections), [modelConnections]);
  // The run's own connection even when inactive, so the picker says it is
  // unavailable rather than naming a key this run does not use. A chosen
  // change shows in its place.
  const runModelConnectionId = run?.model?.modelConnectionId ?? null;
  const selectedModelConnectionId =
    (switching ? switchRow.connectionId : runModelConnectionId) ?? modelChoices.at(0)?.id ?? null;
  const chooseModel = useCallback(
    (connectionId: string, modelId: string) => {
      const choice = { connectionId, modelId };
      // Nothing is sent on choosing: the choice rides the next message, and
      // the note under the composer says what it will do, with a way back.
      setNextModel(
        run === null || !isAnotherModel(run, choice) ? null : { runId: run.runId, choice },
      );
    },
    [run],
  );

  const meterCatalog = useMemo(
    () => catalog ?? catalogOfConnections(modelConnections),
    [catalog, modelConnections],
  );
  // A model chosen for the next run sizes the meter at once: its window is the next call's.
  const chosenProvider = switching ? switchRow.provider : undefined;
  const chosenModelId = switching ? switchRow.modelId : undefined;
  const contextMeter = useMemo(
    () =>
      contextMeterOf(
        { messages: view.messages, runs: view.runs, run: view.run, sandbox: view.sandbox },
        meterCatalog,
        chosenProvider === undefined || chosenModelId === undefined
          ? null
          : { provider: chosenProvider, modelId: chosenModelId },
      ),
    [view.messages, view.runs, view.run, view.sandbox, meterCatalog, chosenProvider, chosenModelId],
  );
  // What the note under the composer says about the chosen model.
  const switchNote =
    switching && run !== null
      ? switchSummary({ row: switchRow, run, usedTokens: contextMeter.used })
      : null;

  const { issue, withdraw, queued, issueAction, commandIdFor, settleAction } = useCommands(
    view.commands,
    sendCommand,
    cancelQueued,
  );
  const [lastCommandId, setLastCommandId] = useState<CommandId | null>(null);
  const [heldNotice, setNotice] = useState<ComposerNotice | null>(null);
  // A held message stops being "waiting to send" the moment it leaves.
  const notice =
    heldNotice?.kind === "queued" && !queued.has(heldNotice.commandId) ? null : heldNotice;
  const rejection =
    lastCommandId === null ? null : (view.commands.get(lastCommandId)?.rejection ?? null);

  /**
   * A message to the object. `hold` keeps it through a disconnect, which only
   * the composer asks for: Continue starts a billed sandbox, so it is never
   * sent minutes later behind the person's back.
   */
  const sendText = useCallback(
    async (
      text: string,
      commandId: string,
      options: SubmitOptions | undefined,
      hold: boolean,
    ): Promise<SubmitResult> => {
      const command = outgoingMessage(
        run,
        text,
        commandId,
        sandboxLive,
        runModelUsable,
        options?.skipRequiredChecks === true,
        options?.effort,
        options?.attachments ?? [],
        switchRow === undefined ? null : switchRecord(switchRow, options?.effort),
      );
      if (command === null) {
        // Nothing to address it to yet (no run has replayed), or the run
        // takes no message now; the note under the composer says which.
        setNotice(intent === "wait" ? null : { kind: "not_ready" });
        return false;
      }
      setNotice(null);
      // The view keys answers by the branded id the object echoes back.
      setLastCommandId(command.commandId);
      // A held message waits while the socket is down: the draft stays on
      // screen, and its command id makes the eventual send a single message.
      const issued = issue(command, { queue: hold });
      if (issued.sent === "queued") {
        setNotice({ kind: "queued", commandId });
      }
      const outcome = await issued.outcome;
      setNotice((current) =>
        current?.kind === "queued" && current.commandId === commandId ? null : current,
      );
      switch (outcome.kind) {
        case "acknowledged":
          return true;
        case "unanswered":
          setNotice({ kind: "unanswered" });
          return "unanswered";
        case "rejected":
          // The rejection line under the composer names it.
          return false;
        case "not_sent":
          setNotice({ kind: "problem", text: outcomeProblem(outcome) ?? "" });
          return false;
        case "withdrawn":
          return false;
      }
    },
    [run, sandboxLive, runModelUsable, intent, issue, switchRow],
  );

  // The composer's send keeps its own command id across an unanswered try.
  const sendMessage = useCallback(
    (
      text: string,
      commandId: string,
      _modelConnectionId?: string | null,
      options?: SubmitOptions,
    ): Promise<SubmitResult> => sendText(text, commandId, options, true),
    [sendText],
  );

  // A send that only waits on the socket may be called back before it leaves.
  const withdrawQueued = useCallback(() => {
    if (notice?.kind === "queued") {
      withdraw(notice.commandId);
    }
  }, [notice, withdraw]);

  // The rail's Run checks; the rail shows its answer beside the button.
  const runChecks = useCallback(
    (): Promise<CommandOutcome | null> =>
      issueAction(`checks:${run?.runId ?? ""}`, (commandId) =>
        checksRequest(run, commandId, runModelUsable),
      ),
    [run, runModelUsable, issueAction],
  );
  const canRunChecks = checksRequest(run, "probe", runModelUsable) !== null;

  // The rail's Continue is the composer's `resume` follow-up, so a rejection
  // shows in the same place. It is not held, and a retry after no answer
  // reuses its id.
  const continueRun = useCallback(async (): Promise<SubmitResult> => {
    const action = `continue:${run?.runId ?? ""}`;
    const commandId = commandIdFor(action);
    const result = await sendText(CONTINUE_MESSAGE, commandId, undefined, false);
    settleAction(action, commandId, result === "unanswered");
    return result;
  }, [run, sendText, commandIdFor, settleAction]);

  // One subagent of its run; the bridge aborts its conversation and the run
  // goes on. It reads "Stopping" from the press until its end moves it to
  // Finished; any outcome but the object's acceptance frees the button and
  // says why on the subagent's row, and so does an accepted stop that has not
  // ended it in `AGENT_STOP_WAIT_MS`.
  const [stoppingAgents, setStoppingAgents] = useState<ReadonlySet<string>>(() => new Set());
  const [stopProblems, setStopProblems] = useState<ReadonlyMap<string, string>>(() => new Map());
  const stoppingRef = useRef(stoppingAgents);
  stoppingRef.current = stoppingAgents;
  const viewRef = useRef(view);
  viewRef.current = view;
  const stopWaits = useRef(new Map<string, number>());
  // The waits die with the screen.
  useEffect(() => {
    const waits = stopWaits.current;
    return () => {
      for (const wait of waits.values()) {
        window.clearTimeout(wait);
      }
      waits.clear();
    };
  }, []);
  /** Ends a subagent's "Stopping", and the wait behind it. */
  const releaseStop = useCallback((agentId: string) => {
    window.clearTimeout(stopWaits.current.get(agentId));
    stopWaits.current.delete(agentId);
    setStoppingAgents((current) => {
      if (!current.has(agentId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(agentId);
      stoppingRef.current = next;
      return next;
    });
  }, []);
  // A subagent that has ended is no longer stopping.
  useEffect(() => {
    for (const agentId of stoppingAgents) {
      const agent = view.agents.get(agentId as never);
      if (agent !== undefined && agentStatusOf(view, agent) !== "running") {
        releaseStop(agentId);
      }
    }
  }, [view, stoppingAgents, releaseStop]);
  const stopAgent = useCallback(
    async (agentId: string): Promise<void> => {
      if (stoppingRef.current.has(agentId)) {
        return;
      }
      const marked = new Set(stoppingRef.current).add(agentId);
      stoppingRef.current = marked;
      setStoppingAgents(marked);
      setStopProblems((current) => withoutKey(current, agentId));
      const outcome = await issueAction(`agent-stop:${agentId}`, (commandId) => {
        const agent = view.agents.get(agentId as never);
        const agentRun = agent === undefined ? undefined : view.runs.get(agent.runId);
        if (agent === undefined || agentRun === undefined) {
          return null;
        }
        return {
          type: "agent.stop",
          commandId,
          runId: agent.runId,
          expected: { scope: "run", state: agentRun.state },
          payload: { agentId },
        } as unknown as OutgoingCommand<"agent.stop">;
      });
      if (outcome?.kind === "acknowledged") {
        // Accepted is not stopped. Still running when the wait runs out, it
        // gets its button back, so the next press is a new stop.
        window.clearTimeout(stopWaits.current.get(agentId));
        stopWaits.current.set(
          agentId,
          window.setTimeout(() => {
            const latest = viewRef.current;
            const agent = latest.agents.get(agentId as never);
            const running = agent !== undefined && agentStatusOf(latest, agent) === "running";
            releaseStop(agentId);
            if (running) {
              setStopProblems((current) => new Map(current).set(agentId, AGENT_STILL_RUNNING));
            }
          }, AGENT_STOP_WAIT_MS),
        );
        return;
      }
      releaseStop(agentId);
      const problem = outcome === null ? null : outcomeProblem(outcome);
      if (problem !== null) {
        setStopProblems((current) => new Map(current).set(agentId, problem));
      }
    },
    [view.agents, view.runs, issueAction, releaseStop],
  );

  // Stop run's problem shows under the composer, where the button is.
  const cancelRun = useCallback(async () => {
    if (run === null) {
      return;
    }
    const outcome = await issueAction(`cancel:${run.runId}`, (commandId) =>
      cancelRunCommand(run, commandId),
    );
    const problem = outcome === null ? null : outcomeProblem(outcome);
    setNotice(problem === null ? null : { kind: "problem", text: `Stop run: ${problem}` });
  }, [run, issueAction]);

  // The suffix is fixed for the life of the screen so the suggested branch
  // name does not change under the cursor.
  const hexSuffix = useMemo(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(2));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }, []);
  const suggestedBranch = useMemo(
    () => suggestBranch(view.git.description, view.messages, hexSuffix),
    [view.git.description, view.messages, hexSuffix],
  );
  // The branch name for the first push: the typed name, else the suggestion.
  // A typed name git would refuse is not sent; the push uses the suggestion.
  const [branchSlug, setBranchSlug] = useState<string | null>(null);
  const chosenBranch =
    branchSlug === null ? suggestedBranch : (branchNameOf(branchSlug) ?? suggestedBranch);
  const namedTaskBranch = namedBranch(view, taskBranch);
  const branchChoice = useMemo(
    () => ({ taskBranch: namedTaskBranch, suggested: chosenBranch }),
    [namedTaskBranch, chosenBranch],
  );
  const branchEditing = useMemo(
    () => ({
      named: namedTaskBranch,
      slug: branchSlug ?? suggestedBranch.slice(BRANCH_PREFIX.length),
      onSlugChange: setBranchSlug,
      baseBranch,
      existing: branchMode === "existing_branch",
      repository,
    }),
    [namedTaskBranch, branchSlug, suggestedBranch, baseBranch, branchMode, repository],
  );
  const pendingPolicy = useMemo(() => {
    const proposalId = view.policy.pendingProposal?.proposalId;
    return proposalId === undefined
      ? null
      : (view.policy.changes.find(
          (change) => change.kind === "proposed" && change.proposalId === proposalId,
        ) ?? null);
  }, [view.policy]);

  // Each answer is its own action, keyed by everything its payload holds.
  const sendPolicy = useCallback(
    async (action: string, payload: PolicyPayload): Promise<CommandOutcome> =>
      (await issueAction(action, (commandId) => policyCommand(commandId, payload))) ?? {
        kind: "not_sent",
      },
    [issueAction],
  );
  const answerPolicy = useCallback(
    (answer: PolicyAnswer): Promise<CommandOutcome> =>
      answer.action === "decline"
        ? sendPolicy(`policy:decline:${answer.proposalId}`, {
            action: "decline",
            proposalId: asProposalId(answer.proposalId),
          })
        : sendPolicy(
            `policy:confirm:${answer.proposalId}:${answer.policyVersion}:${answer.branchName ?? ""}`,
            {
              action: "confirm",
              proposalId: asProposalId(answer.proposalId),
              policyVersion: answer.policyVersion,
              ...(answer.branchName === undefined ? {} : { branchName: answer.branchName }),
            },
          ),
    [sendPolicy],
  );
  const setPolicy = useCallback(
    (change: PolicySwitch): Promise<CommandOutcome> =>
      sendPolicy(`policy:set:${JSON.stringify(change)}`, { action: "set", ...change }),
    [sendPolicy],
  );

  // Only the approval id and decision: who decided and when are the control
  // plane's to record (records 04 and 09). An expired card's click is refused.
  const sendApproval = useCallback(
    async (answer: ApprovalAnswer): Promise<CommandOutcome> => {
      if (run === null) {
        return { kind: "not_sent" };
      }
      return (
        (await issueAction(`approval:${answer.approvalId}:${answer.decision}`, (commandId) =>
          approvalCommand(run.runId, commandId, answer),
        )) ?? { kind: "not_sent" }
      );
    },
    [run, issueAction],
  );

  const waiting = needsNewKey || switching ? null : waitReason(run, sandboxLive, runModelUsable);
  const failureNote =
    modelPause === null
      ? null
      : modelFailureNote({
          failure: modelPause,
          sandboxLive,
          connection: keyStateKnown ? runConnection : null,
        });
  // A model failure names itself; otherwise the key the next message needs, or the wait.
  // A model chosen for the next run has its own note, which replaces these.
  const runNote: RunNote | null = switching
    ? null
    : failureNote !== null
      ? {
          testId: "composer-model-failure",
          text: modelFailureNoteText(failureNote),
          linksToKeys: failureNote.linksToKeys,
        }
      : needsNewKey && runConnection !== "active"
        ? {
            testId: "composer-model-unavailable",
            text: KEY_GUIDANCE[runConnection],
            linksToKeys: true,
          }
        : waiting !== null
          ? { testId: "composer-wait", text: WAIT_GUIDANCE[waiting], linksToKeys: false }
          : null;
  // The other way on from a key that stopped working: a model on a key that works.
  const offersAnotherModel =
    !archived && runNote?.linksToKeys === true && modelSwitchable && canOfferAnotherModel;
  // Said under the composer while the socket is down, so typing on is not a surprise.
  const disconnected = connection === "reconnecting" || connection === "offline";
  // The open question, answered or dismissed through the card above the
  // composer. Who answered is the control plane's to record.
  const openQuestion =
    view.openQuestionId === null ? null : (view.questions.get(view.openQuestionId) ?? null);
  // The answer on its way: which question it answers, and its command. The
  // card waits only for its own question's answer, and gets the controls back
  // on a refusal or when no answer came within `ANSWER_TIMEOUT_MS`, as a
  // message does; a late duplicate is refused harmlessly.
  const [questionSent, setQuestionSent] = useState<{
    readonly questionId: string;
    readonly commandId: string;
  } | null>(null);
  useEffect(() => {
    if (questionSent === null) {
      return;
    }
    const timer = window.setTimeout(
      () => setQuestionSent((current) => (current === questionSent ? null : current)),
      ANSWER_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [questionSent]);
  const questionSending =
    questionSent !== null &&
    questionSent.questionId === openQuestion?.questionId &&
    view.commands.get(questionSent.commandId as CommandId)?.state !== "rejected";
  const sendQuestion = useCallback(
    (answer: QuestionAnswer): boolean => {
      if (run === null) {
        return false;
      }
      const commandId = crypto.randomUUID();
      // An answer is a one-shot control: never held through a disconnect, so
      // the card gets its controls back at once when no socket took it.
      const sent =
        sendCommand({
          type: "question.resolve",
          commandId,
          runId: openQuestion?.runId ?? run.runId,
          expected: { scope: "run", state: run.state },
          payload: answer,
        } as unknown as OutgoingCommand<"question.resolve">) === "sent";
      if (sent) {
        setQuestionSent({ questionId: answer.questionId, commandId });
        setLastCommandId(commandId as CommandId);
      }
      return sent;
    },
    [run, openQuestion, sendCommand],
  );
  // Where focus goes when the card closes under it: the composer, which is
  // where the conversation continues.
  const composerArea = useRef<HTMLDivElement | null>(null);
  const focusComposer = useCallback(() => {
    composerArea.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, []);

  // An archived session is read-only (record 10): nothing that answers the
  // agent or changes the session is offered, only the timeline and Unarchive.
  const cardQuestion = archived ? null : openQuestion;

  const approvals = useSessionApprovals(view, run, issueAction);
  // The picker means nothing for a harness whose gate never asks.
  const showApprovals = harnessAsksPermission(runtime);

  if (denied) {
    return <SessionNotFound />;
  }

  return (
    // The conversation is always the first panel, so opening the side panel
    // never remounts the timeline or its scroller.
    <ResizablePanelGroup orientation="horizontal" className="bg-canvas">
      <ResizablePanel id="conversation" minSize="360px" className="h-full">
        <div className="relative flex h-full min-w-0 flex-col">
          <SessionHeader
            connection={connection}
            hasUnsentInput={hasUnsentInput}
            railPinned={railPinned}
            onPinRail={() => setRailPinned(true)}
            panelOpen={side !== null}
            onTogglePanel={togglePanel}
            menu={
              <SessionMenu
                sessionId={sessionId}
                title={title}
                archived={archived}
                runOpen={view.run !== null && view.run.outcome === null}
                triggerClassName="size-8 rounded-lg text-muted-foreground hover:bg-hover"
              />
            }
            sandboxPhase={sandboxPhaseOf(sandbox)}
          />

          {/* The panel narrows the conversation, and the floating rail would
              cover what is left of it; the rail returns when the panel closes. */}
          {railPinned && side === null ? (
            <ContextRail
              view={view}
              taskBranch={taskBranch}
              baseBranch={baseBranch}
              existingBranch={branchMode === "existing_branch"}
              onUnpin={() => setRailPinned(false)}
              onOpenChanges={() => openReview(DEFAULT_REVIEW)}
              onOpenTests={() =>
                openReview({ tab: "tests", scope: "turn", runId: view.run?.runId ?? null })
              }
              onContinue={continueRun}
              onRunChecks={canRunChecks ? runChecks : undefined}
              onSetPolicy={setPolicy}
              suggestedBranch={chosenBranch}
              onOpenPullRequest={() => openPanel("pullRequest")}
              runConnection={runConnection}
              keyStateKnown={keyStateKnown}
            />
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col">
            <Timeline
              view={view}
              sessionId={sessionId}
              onReview={openReview}
              onPolicyAnswer={answerPolicy}
              branch={branchChoice}
              onApprovalAnswer={sendApproval}
              onOpenAgent={openAgent}
              onOpenAgents={openAgents}
              contextRef={conversation}
              decisionsAbove
              catalog={meterCatalog}
              pauseLinksToKeys={failureNote?.linksToKeys}
            />

            <div className="shrink-0 px-6 pb-5">
              <div ref={composerArea} className="mx-auto max-w-[720px]">
                {/* Always present, so a screen reader hears a card that opens. */}
                <p role="status" className="sr-only" data-testid="question-announcement">
                  {cardQuestion === null ? "" : questionAnnouncement(cardQuestion)}
                </p>
                {cardQuestion === null ? null : (
                  // The agent's questions wait above the composer, one card at a time.
                  <div className="mb-3">
                    <QuestionCard
                      key={cardQuestion.questionId}
                      question={cardQuestion}
                      onAnswer={sendQuestion}
                      sending={questionSending}
                      onClosedWithFocus={focusComposer}
                    />
                  </div>
                )}
                {pendingPolicy === null || archived ? null : (
                  // The pending question sits above the composer (record 13).
                  <div className="mb-3">
                    <PolicyRow
                      view={view}
                      change={pendingPolicy}
                      onAnswer={answerPolicy}
                      branch={branchChoice}
                      repository={repository}
                    />
                  </div>
                )}
                {archived || approvals.open === null || openQuestion !== null ? null : (
                  // The agent's own permission ask waits above the composer
                  // (record 09), one card at a time: an open question first,
                  // since the run is paused on it.
                  <div className="mb-3">
                    <PermissionCard
                      key={approvals.open.approvalId}
                      approval={approvals.open}
                      onAnswer={approvals.answer}
                    />
                  </div>
                )}
                {archived ? (
                  <ArchivedNotice sessionId={sessionId} />
                ) : (
                  <Composer
                    sessionId={sessionId}
                    intent={intent}
                    placeholder="Reply to steer this run, or queue the next one"
                    repositoryLabel={repository}
                    modelConnections={modelChoices}
                    runtimes={runtimes}
                    selectedRuntimeId={runtime}
                    selectedModelConnectionId={selectedModelConnectionId}
                    selectedModelId={switching ? switchRow.modelId : (run?.model?.modelId ?? null)}
                    // A changed model opens on its own default effort, not the run's.
                    {...(switching ? {} : { effort: run?.model?.effort ?? null })}
                    // Between runs the chip chooses the next run's model, and
                    // it opens even when the run's own key takes no message.
                    {...(modelSwitchable
                      ? { onSelectModel: chooseModel, agentChipEnabled: true }
                      : {})}
                    onUnsentChange={setHasUnsentInput}
                    onCancelRun={cancelRun}
                    showCancelRun={canCancelRun}
                    onSubmit={onSubmit ?? sendMessage}
                    {...(showApprovals
                      ? { approvalMode: approvals.mode, onApprovalModeChange: approvals.changeMode }
                      : {})}
                    // Under the box's bottom-right corner, on the approvals picker's line.
                    belowEnd={<ContextMeter meter={contextMeter} />}
                    disabled={needsNewKey}
                    messageDescribedBy={
                      runNote !== null
                        ? RUN_NOTE_ID
                        : notice !== null || disconnected
                          ? SEND_NOTE_ID
                          : undefined
                    }
                  />
                )}
                {runNote === null || archived ? null : (
                  <div className="mt-2 px-1 text-[13px] text-muted-foreground">
                    <p id={RUN_NOTE_ID} role="status" data-testid={runNote.testId}>
                      {runNote.text}
                    </p>
                    {runNote.linksToKeys ? <ModelConnectionsLink /> : null}
                  </div>
                )}
                {offersAnotherModel ? (
                  // The other way on from a refused key: a model on a key that works.
                  <p
                    data-testid="composer-model-switch-hint"
                    className="mt-1 px-1 text-[13px] text-muted-foreground"
                  >
                    Or open the model menu in the box above and choose another model to continue on.
                  </p>
                ) : null}
                {switchNote !== null && !archived ? (
                  <div
                    role="status"
                    data-testid="composer-next-model"
                    className="mt-2 px-1 text-[13px] text-muted-foreground"
                  >
                    <p className="flex flex-wrap items-center gap-x-2">
                      <span>
                        Your next message starts a run on {switchNote.modelName}
                        {switchNote.effort === null ? "" : ` at ${switchNote.effort} effort`},
                        charged to your {switchNote.charged}.
                      </span>
                      <button
                        type="button"
                        onClick={() => setNextModel(null)}
                        data-testid="composer-next-model-undo"
                        className="rounded underline underline-offset-2 hover:text-text"
                      >
                        Keep the current model
                      </button>
                    </p>
                    {switchNote.endsRun ? (
                      <p className="mt-1" data-testid="composer-next-model-ends-run">
                        The current run is paused or interrupted and keeps its model, so it ends
                        when you send, and a new run continues its conversation.
                      </p>
                    ) : null}
                    {switchNote.shortfalls.map((shortfall) => (
                      <p
                        key={shortfall}
                        className="mt-1 text-caution"
                        data-testid="composer-next-model-shortfall"
                      >
                        {shortfall}
                      </p>
                    ))}
                  </div>
                ) : null}
                <SendNotice
                  notice={notice}
                  disconnected={disconnected}
                  onWithdraw={withdrawQueued}
                />
                {rejection === null ? null : (
                  <p
                    role="status"
                    data-testid="composer-rejection"
                    className="mt-2 px-1 text-[13px] text-danger"
                  >
                    The message was not accepted: {rejection.reason} ({rejection.detail})
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </ResizablePanel>

      {side === null ? null : (
        <>
          <ResizableHandle aria-label="Resize the side panel" />
          <ResizablePanel
            // A diff wants half the screen and the other panes do not, so the
            // panel remounts at the wider size the moment Review joins it.
            key={side.open.includes("review") ? "side-wide" : "side"}
            id="side"
            defaultSize={side.open.includes("review") ? "50%" : "420px"}
            minSize="320px"
            maxSize="75%"
            className="h-full border-border border-l"
          >
            <SessionPanel
              view={view}
              sessionId={sessionId}
              open={side.open}
              active={side.active}
              reviewTarget={side.review}
              onSelectTab={openPanel}
              onCloseTab={closeTab}
              onClose={() => setSide(null)}
              onReviewTargetChange={openReview}
              branch={branchEditing}
              sandbox={sandbox}
              onStopSandbox={stop}
              onKeepAlive={keepAlive}
              agents={{
                selectedAgentId: side.agent ?? null,
                onSelectAgent: openAgent,
                // An archived session is read-only: its Agents view offers no stop.
                onStopAgent: archived ? undefined : (agentId: string) => void stopAgent(agentId),
                stopping: stoppingAgents,
                stopProblems,
                cleared: clearedAgents,
                onClearFinished: clearFinishedAgents,
                modelConnections,
              }}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/**
 * What the side panel shows: the tabs the reader has opened, which is in
 * front, and what the Review tab is on. `null` is the panel closed; no open
 * tab and no active one is the panel on its list of views.
 */
type SideState = {
  readonly open: readonly PanelTab[];
  readonly active: PanelTab | null;
  readonly review: ReviewTarget;
  /** The subagent the Agents view shows; absent or null is its list. */
  readonly agent?: string | null;
};

const DEFAULT_REVIEW: ReviewTarget = { tab: "review", scope: "session", runId: null };
