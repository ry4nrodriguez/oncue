import {
  type ApprovalMode,
  type ArtifactRef,
  ATTACHMENT_ACCEPT,
  type EffortLevel,
} from "@oncue/protocol";
import { ArrowUp, Mic, MicOff, ShieldOff, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApprovalModeMenu } from "@/features/approvals/ApprovalModeMenu";
import {
  connectedProvidersOf,
  harnessForProvider,
  harnessOptions,
  selectedHarnessOf,
} from "@/features/harnesses/harness-state";
import { RepositoryPicker } from "@/features/repositories/RepositoryPicker";
import { discardAttachment, uploadAttachment } from "@/lib/api/attachments";
import type { ModelCatalog, RepositorySummary, RuntimeSummary } from "@/lib/api/setup";
import { cn } from "@/lib/utils";
import { AddMenu } from "./AddMenu";
import { AgentChip } from "./AgentChip";
import { AttachmentStrip } from "./attachments/AttachmentStrip";
import { type AttachmentsApi, useAttachments } from "./attachments/use-attachments";
import {
  canSubmit,
  clearDraft,
  intentLabel,
  loadDraft,
  nextCommandId,
  type SubmitIntent,
  saveDraft,
} from "./composer-state";
import {
  type InactiveKey,
  type ModelChoice,
  menuRowsOf,
  modelRowsOf,
  selectedRowOf,
} from "./ModelPicker";
import {
  DICTATION_DENIED_TOOLTIP,
  DICTATION_TOOLTIP,
  type SpeechRecognitionConstructor,
  speechRecognitionOf,
  useDictation,
} from "./use-dictation";

const NO_REPOSITORIES: readonly RepositorySummary[] = [];
const NO_MODEL_CONNECTIONS: readonly ModelChoice[] = [];
const NO_RUNTIMES: readonly RuntimeSummary[] = [];

// Where no selection handler is passed, the picker still opens and choosing does nothing.
function noSelection(): void {}

export type SubmitResult = boolean | "unanswered";

/** What the composer's add menu set for this one send. */
export type SubmitOptions = {
  /** The run skips its required checks, so it cannot end verified. */
  readonly skipRequiredChecks: boolean;
  /** The catalog model on the selected connection; `null` names its recommended row. */
  readonly modelId?: string | null;
  /** The run's effort, one of the model's own levels; `null` for a model with none. */
  readonly effort?: EffortLevel | null;
  /** The files attached to this message, as the Worker recorded each upload. */
  readonly attachments?: readonly ArtifactRef[];
  /** The harness a new session runs; absent means the Worker's default. */
  readonly runtime?: string;
};

const REAL_ATTACHMENTS: AttachmentsApi = {
  upload: uploadAttachment,
  discard: discardAttachment,
};

function filesOf(list: FileList | null | undefined): File[] {
  return list === null || list === undefined ? [] : Array.from(list);
}

/** The field grows with its text up to this many lines, then scrolls. */
export const FIELD_MAX_LINES = 6;
const LINE_PX = 24;

/**
 * Sizes the field to its text, from two lines up to `FIELD_MAX_LINES`. Without
 * layout (a test runner) there is no scroll height and the field keeps its rows.
 */
function fitField(field: HTMLTextAreaElement | null) {
  if (field === null) {
    return;
  }
  field.style.height = "auto";
  const wanted = field.scrollHeight;
  field.style.height = wanted === 0 ? "" : `${Math.min(wanted, FIELD_MAX_LINES * LINE_PX)}px`;
}

export type ComposerProps = {
  sessionId: string;
  /** What a send will do, from `intentFor`; on Home a message always starts a run. */
  intent?: SubmitIntent;
  disabled?: boolean;
  /** The id of text outside the composer that explains the message box, such as why it is disabled. */
  messageDescribedBy?: string | undefined;
  placeholder?: string;
  /** Empty until GitHub is connected; the control then says so rather than disappearing. */
  repositories?: readonly RepositorySummary[];
  selectedRepositoryId?: string | null;
  onSelectRepository?: (repositoryConnectionId: string) => void;
  /** A session's repository is fixed, so the session screen passes this instead. */
  repositoryLabel?: string | null;
  /** The branch control beside the repository (`BranchPicker`), on Home only. */
  branchPicker?: React.ReactNode;
  /**
   * The workspace's model connections, and which one this send uses. Controlled
   * by the caller, since the Worker resolves `modelConnectionId` into the run's model.
   */
  modelConnections?: readonly ModelChoice[];
  selectedModelConnectionId?: string | null;
  onSelectModelConnection?: (modelConnectionId: string) => void;
  /** The catalog model on that connection; `null` opens on its recommended row. */
  selectedModelId?: string | null;
  onSelectModel?: (connectionId: string, modelId: string) => void;
  /**
   * The harnesses this deployment enables (`AgentChip`). A session passes no
   * `onSelectRuntime`, since it keeps the harness it started with.
   */
  runtimes?: readonly RuntimeSummary[];
  selectedRuntimeId?: string | null;
  onSelectRuntime?: (runtimeId: string) => void;
  /** Every provider's models, so the agent chip can list one whose key is missing. */
  catalog?: ModelCatalog;
  /** Providers whose key stopped working, which the agent chip lists with the way to replace it. */
  inactiveKeys?: readonly InactiveKey[];
  /** The effort the chip opens on (a session passes its run's); absent, the model's default. */
  effort?: EffortLevel | null;
  /**
   * Whether the agent chip opens while the box itself is disabled. A session
   * whose run's key was refused takes no message, and the way forward is to
   * pick another model there (record 15). Absent, the chip follows `disabled`.
   */
  agentChipEnabled?: boolean;
  /**
   * Resolves true when accepted, false when rejected, and "unanswered" when
   * nothing answered. A rejected message is retried under a new id, because
   * the object answers a reused id with its first answer; an unanswered one
   * is retried under the same id, so a late answer is harmless.
   */
  onSubmit?: (
    text: string,
    commandId: string,
    modelConnectionId: string | null,
    options: SubmitOptions,
  ) => Promise<SubmitResult> | SubmitResult;
  /** Fires when the draft goes from empty to non-empty or back. */
  onUnsentChange?: (hasUnsent: boolean) => void;
  /**
   * Cancels the run and keeps the sandbox (record 10). It replaces the send
   * button while a run is active and the box is empty, since typing means a steer.
   */
  onCancelRun?: () => unknown;
  showCancelRun?: boolean;
  /** Where attachments are uploaded and discarded; tests pass their own. */
  attachmentsApi?: AttachmentsApi;
  /** The browser's speech recognizer; detected by default, and null hides the mic. */
  speechRecognition?: SpeechRecognitionConstructor | null;
  /**
   * How the agent's permission asks are answered (record 09), shown by the
   * picker below the box; null when the workspace's setting cannot be read.
   * Absent hides the picker.
   */
  /** Shown at the right of the line below the box, across from the approvals picker. */
  belowEnd?: ReactNode;
  approvalMode?: ApprovalMode | null;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
};

export function Composer({
  sessionId,
  intent = "start_next",
  disabled = false,
  messageDescribedBy,
  placeholder = "Ask or build anything",
  repositories = NO_REPOSITORIES,
  selectedRepositoryId = null,
  onSelectRepository,
  repositoryLabel = null,
  branchPicker = null,
  modelConnections = NO_MODEL_CONNECTIONS,
  selectedModelConnectionId = null,
  onSelectModelConnection,
  selectedModelId = null,
  onSelectModel,
  runtimes = NO_RUNTIMES,
  selectedRuntimeId = null,
  onSelectRuntime,
  catalog,
  inactiveKeys,
  effort: openingEffort,
  agentChipEnabled,
  onSubmit,
  onUnsentChange,
  onCancelRun,
  showCancelRun = false,
  attachmentsApi = REAL_ATTACHMENTS,
  speechRecognition = speechRecognitionOf(typeof window === "undefined" ? null : window),
  approvalMode,
  belowEnd,
  onApprovalModeChange,
}: ComposerProps) {
  // The draft is read once per session so a remount restores what was typed.
  const [text, setTextState] = useState(() => loadDraft(sessionId));
  const [sending, setSending] = useState(false);
  // Every harness in the catalog with its state; none when the Worker sent no list.
  const harnesses = useMemo(
    () =>
      runtimes.length === 0 ? [] : harnessOptions(runtimes, connectedProvidersOf(modelConnections)),
    [runtimes, modelConnections],
  );
  const harnessFixed = onSelectRuntime === undefined;
  const harness = selectedHarnessOf(harnesses, selectedRuntimeId, harnessFixed);
  // A send names its harness only when there was a choice.
  const runtime = runtimes.length > 1 ? harness : null;
  const rows = useMemo(() => modelRowsOf(modelConnections), [modelConnections]);
  const selectedRow = selectedRowOf(rows, selectedModelConnectionId, selectedModelId);
  const selectedKey = selectedRow?.key ?? null;
  const effortLevels = selectedRow?.spec?.effort ?? null;
  // A chosen effort is kept with its row, so switching models returns to that
  // model's default rather than a level it may not offer.
  const [chosenEffort, setChosenEffort] = useState<{
    readonly key: string | null;
    readonly effort: EffortLevel;
  } | null>(null);
  const effort: EffortLevel | null =
    chosenEffort !== null && chosenEffort.key === selectedKey
      ? chosenEffort.effort
      : (openingEffort ?? selectedRow?.spec?.defaultEffort ?? null);
  // For the next message only: cleared once a send is accepted, kept for a
  // retry of the same message.
  const [skipRequiredChecks, setSkipRequiredChecks] = useState(false);
  // A ref: the id is never rendered, and `submit` reads it right after writing it.
  const pendingCommandId = useRef<string | null>(null);
  // The add panel lines up with the whole composer, not its button.
  const composer = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the field is refit each time its text changes
  useLayoutEffect(() => {
    fitField(field.current);
  }, [text]);
  const attachments = useAttachments(attachmentsApi);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Whether files are being dragged over the composer, for the drop hint.
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const restored = loadDraft(sessionId);
    setTextState(restored);
    pendingCommandId.current = null;
    // A restored draft is unsent input too.
    onUnsentChange?.(canSubmit(restored));
  }, [sessionId, onUnsentChange]);

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      saveDraft(sessionId, next);
      onUnsentChange?.(canSubmit(next));
    },
    [sessionId, onUnsentChange],
  );

  // The mic writes into the same draft as the keyboard.
  const textRef = useRef(text);
  textRef.current = text;
  const currentText = useCallback(() => textRef.current, []);
  const dictation = useDictation(currentText, setText, speechRecognition);

  // Off while a stop is out, so a double click sends one cancel.
  const [stopping, setStopping] = useState(false);
  const stopRun = useCallback(async () => {
    if (onCancelRun === undefined) {
      return;
    }
    setStopping(true);
    try {
      await onCancelRun();
    } finally {
      setStopping(false);
    }
  }, [onCancelRun]);

  // `wait`: the run takes no message now; the session screen says why.
  const blocked = intent === "wait";
  const submit = useCallback(async () => {
    if (disabled || blocked || sending || !canSubmit(text) || attachments.blocking) {
      return;
    }
    const commandId = nextCommandId(pendingCommandId.current);
    pendingCommandId.current = commandId;

    setSending(true);
    try {
      const result =
        (await onSubmit?.(text, commandId, selectedModelConnectionId, {
          skipRequiredChecks,
          modelId: selectedRow?.modelId ?? null,
          effort,
          attachments: attachments.refs,
          ...(runtime === null ? {} : { runtime: runtime.id }),
        })) ?? true;
      if (result === true) {
        pendingCommandId.current = null;
        setText("");
        clearDraft(sessionId);
        setSkipRequiredChecks(false);
        attachments.clear();
      } else if (result === false) {
        // Rejected: the text stays, the id does not.
        pendingCommandId.current = null;
      }
      // Unanswered: the text and the id both stay for the retry.
    } finally {
      setSending(false);
    }
  }, [
    disabled,
    blocked,
    sending,
    text,
    onSubmit,
    sessionId,
    setText,
    selectedModelConnectionId,
    selectedRow,
    effort,
    skipRequiredChecks,
    attachments,
    runtime,
  ]);

  const ready = canSubmit(text) && !disabled && !blocked && !attachments.blocking;

  // A harness that cannot run the chosen model moves the choice to a model it
  // can run, its recommended one where there is one.
  const selectRuntime = useCallback(
    (runtimeId: string) => {
      onSelectRuntime?.(runtimeId);
      const next = harnesses.find((option) => option.id === runtimeId);
      const provider = selectedRow?.provider;
      if (next === undefined || provider === undefined || next.providers.includes(provider)) {
        return;
      }
      // Among the rows the menu lists, so it picks the connection a person would.
      const runnable = menuRowsOf(rows, selectedModelConnectionId).filter(
        (row) => row.provider !== undefined && next.providers.includes(row.provider),
      );
      const target = runnable.find((row) => row.spec?.recommended === true) ?? runnable[0];
      if (target !== undefined) {
        onSelectModelConnection?.(target.connectionId);
        onSelectModel?.(target.connectionId, target.modelId);
      }
    },
    [
      onSelectRuntime,
      harnesses,
      selectedRow,
      rows,
      selectedModelConnectionId,
      onSelectModelConnection,
      onSelectModel,
    ],
  );
  // Choosing a model the harness cannot run moves to the first harness that can.
  const selectModel = useCallback(
    (connectionId: string, modelId: string) => {
      onSelectModel?.(connectionId, modelId);
      const provider = rows.find(
        (row) => row.connectionId === connectionId && row.modelId === modelId,
      )?.provider;
      if (harness === null || provider === undefined || harness.providers.includes(provider)) {
        return;
      }
      const next = harnessForProvider(harnesses, provider);
      if (next !== undefined) {
        onSelectRuntime?.(next.id);
      }
    },
    [onSelectModel, rows, harness, harnesses, onSelectRuntime],
  );
  const modelSelectable = onSelectModel !== undefined || onSelectModelConnection !== undefined;

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    const files = filesOf(event.dataTransfer.files);
    if (disabled || files.length === 0) {
      return;
    }
    event.preventDefault();
    attachments.add(files);
  };
  // A pasted image or file is attached; pasted text is typed as always.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesOf(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    attachments.add(files);
  };
  const stopInstead = onCancelRun !== undefined && showCancelRun && !ready;

  // How the agent's own permission asks are answered: a plain picker on its
  // own line just below the composer's box, at its left.
  const approvalCell =
    approvalMode === undefined ? null : (
      <ApprovalModeMenu mode={approvalMode} onChange={onApprovalModeChange} disabled={disabled} />
    );
  return (
    <div data-testid="composer-dock">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the Add menu is the keyboard path to the same thing */}
      <div
        ref={composer}
        data-testid="composer"
        data-dragging={dragging ? "true" : undefined}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "relative rounded-2xl border bg-composer shadow-[0_1px_2px_rgb(0_0_0/4%),0_16px_40px_-16px_rgb(0_0_0/16%)] backdrop-blur-sm",
          dragging ? "border-accent" : "border-border",
        )}
      >
        {dragging ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-composer/85 text-[13px] text-text"
          >
            Drop files to attach them
          </div>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          data-testid="composer-file-input"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            attachments.add(filesOf(event.target.files));
            // The same file chosen again after a remove is a new choice.
            event.target.value = "";
          }}
        />
        <div className="px-4 pt-4 pb-1">
          <AttachmentStrip
            items={attachments.items}
            notice={attachments.notice}
            onRemove={attachments.remove}
            disabled={sending}
          />
          <textarea
            ref={field}
            rows={2}
            value={text}
            disabled={disabled}
            // What is in the box is what is being sent, so it holds still until
            // the send is answered or withdrawn.
            readOnly={sending}
            aria-label="Message"
            aria-describedby={messageDescribedBy}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              // Enter sends and Shift+Enter breaks the line; Cmd+Enter also sends.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            className="scroll-pill max-h-[144px] w-full resize-none overflow-y-auto bg-transparent text-[15px] text-text leading-6 outline-none placeholder:text-faint disabled:opacity-60"
          />
          {skipRequiredChecks ? (
            <div className="pb-1">
              <span
                data-testid="composer-skip-chip"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pr-1 pl-2 text-[12px] text-text"
              >
                <ShieldOff className="size-3 text-caution" aria-hidden="true" />
                Skip required checks
                <button
                  type="button"
                  aria-label="Stop skipping required checks"
                  onClick={() => setSkipRequiredChecks(false)}
                  className="flex size-4 items-center justify-center rounded-full text-faint transition-colors hover:bg-hover hover:text-text"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between px-2.5 pb-2.5">
          {/* Add acts on the message, so it sits with the box rather than in the strip. */}
          <AddMenu
            disabled={disabled}
            onChoose={(choice) => {
              if (choice === "files") {
                fileInput.current?.click();
              }
            }}
            anchorRef={composer}
            coverRef={strip}
            skipRequiredChecks={skipRequiredChecks}
            onSkipRequiredChecksChange={setSkipRequiredChecks}
          />

          <div className="flex items-center gap-0.5">
            {dictation.supported ? (
              <button
                type="button"
                aria-label={dictation.state === "listening" ? "Stop dictating" : "Dictate"}
                aria-pressed={dictation.state === "listening"}
                title={dictation.state === "denied" ? DICTATION_DENIED_TOOLTIP : DICTATION_TOOLTIP}
                data-testid="composer-dictate"
                data-state={dictation.state}
                disabled={disabled}
                onClick={dictation.toggle}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg transition-colors disabled:opacity-60",
                  dictation.state === "listening"
                    ? "bg-accent/15 text-accent"
                    : dictation.state === "denied"
                      ? "text-danger hover:bg-hover"
                      : "text-muted-foreground hover:bg-hover hover:text-text",
                )}
              >
                {dictation.state === "denied" ? (
                  <MicOff className="size-[18px]" aria-hidden="true" />
                ) : (
                  <Mic
                    className={cn(
                      "size-[18px]",
                      dictation.state === "listening" ? "animate-pulse" : "",
                    )}
                    aria-hidden="true"
                  />
                )}
              </button>
            ) : null}
            {stopInstead ? (
              <>
                {/* Send becomes stop while the run works and the box is empty. */}
                <button
                  type="button"
                  aria-label="Stop run"
                  aria-describedby="composer-stop-run-description"
                  aria-busy={stopping}
                  disabled={stopping}
                  onClick={() => void stopRun()}
                  data-testid="composer-stop"
                  className="ml-1 flex size-8 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:brightness-110 disabled:opacity-60"
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                </button>
                {/*
                Cancels the run and keeps the sandbox, unlike "Stop sandbox"
                (record 10); an accessible description keeps the label short.
              */}
                <span id="composer-stop-run-description" className="sr-only">
                  Cancels the run and keeps the sandbox running. To stop the sandbox itself, use
                  "Stop sandbox" in the Modal panel.
                </span>
              </>
            ) : (
              <button
                type="button"
                aria-label="Send message"
                // What this send does is a tooltip; the placeholder already says it.
                title={
                  attachments.blocking
                    ? "Wait for the files to finish uploading, or remove the ones that failed"
                    : intentLabel(intent)
                }
                disabled={!ready || sending}
                onClick={() => void submit()}
                className={cn(
                  "ml-1 flex size-8 items-center justify-center rounded-lg transition-colors",
                  // A send in flight is not drawn as ready to send again.
                  ready && !sending
                    ? "bg-accent text-white hover:brightness-110"
                    : "text-faint hover:bg-hover hover:text-muted-foreground",
                )}
              >
                <ArrowUp className="size-[17px]" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {/*
        What this send runs against: where on the left, the agent on the right.
        The strip is a size container, so its controls shorten by its own
        width rather than the window's, since the side panel narrows the pane.
      */}
        <div
          ref={strip}
          data-testid="composer-strip"
          className="@container/strip rounded-b-2xl border-border border-t bg-strip px-2.5 py-1.5"
        >
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <RepositoryPicker
                repositories={repositories}
                selectedId={selectedRepositoryId}
                onSelect={onSelectRepository ?? noSelection}
                disabled={disabled}
                fixedLabel={repositoryLabel}
              />
              {branchPicker}
            </div>
            <AgentChip
              harnesses={harnesses}
              selectedHarnessId={harness?.id ?? null}
              onSelectHarness={harnessFixed ? undefined : selectRuntime}
              choices={modelConnections}
              selectedConnectionId={selectedModelConnectionId}
              selectedModelId={selectedRow?.modelId ?? null}
              onSelectConnection={onSelectModelConnection}
              onSelectModel={modelSelectable ? selectModel : undefined}
              catalog={catalog}
              inactiveKeys={inactiveKeys}
              effortLevels={effortLevels}
              effort={effort}
              onEffortChange={(level) => setChosenEffort({ key: selectedKey, effort: level })}
              disabled={agentChipEnabled === true ? false : disabled}
            />
          </div>
        </div>
      </div>
      {approvalCell === null && belowEnd === undefined ? null : (
        // One line under the box: how asks are answered at the left, what
        // else belongs to this send at the right.
        <div
          data-testid="composer-below"
          className="mt-1.5 flex min-w-0 items-center justify-between gap-2 px-1"
        >
          <div className="flex min-w-0 items-center">{approvalCell}</div>
          {belowEnd === undefined ? null : (
            <div className="flex shrink-0 items-center">{belowEnd}</div>
          )}
        </div>
      )}
    </div>
  );
}
