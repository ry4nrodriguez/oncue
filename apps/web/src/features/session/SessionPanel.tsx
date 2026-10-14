/**
 * The side panel's closable tabs (record 13). Sandbox output is untrusted, so
 * it is shown verbatim in a monospace box and never used as a label. Stop ends
 * compute in the user's Modal account, so it needs confirmation; keep-alive
 * spends at most an hour and Stop undoes it, so it does not.
 */

import type { SandboxActionView, SandboxView, SessionView } from "@oncue/protocol";
import {
  ChevronDown,
  Diamond,
  FileDiff,
  GitPullRequest,
  Globe,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ModalMark } from "@/components/brand/icons";
import { DANGER_ACTION, ROW_ACTION } from "@/components/ui/button-classes";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReviewPanel } from "@/features/diff/ReviewPanel";
import type { ReviewTarget } from "@/features/diff/review-model";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { cn } from "@/lib/utils";
import { keyed } from "./ActionRow";
import { AgentsPane, type AgentsPaneProps } from "./agents/AgentsPane";
import { type BranchEditing, PullRequestPane } from "./PullRequestPane";
import {
  formatClockTime,
  formatElapsed,
  type SandboxPhase,
  sandboxPhaseOf,
  sandboxRunningMs,
  useNow,
} from "./sandbox-time";
import { TerminalPane } from "./TerminalPane";
import { sandboxSteps } from "./Timeline";

export type PanelTab = "modal" | "review" | "pullRequest" | "terminal" | "agents" | "preview";

export const PANEL_TABS: readonly { readonly tab: PanelTab; readonly label: string }[] = [
  { tab: "modal", label: "Modal" },
  { tab: "review", label: "Review" },
  { tab: "pullRequest", label: "Pull request" },
  { tab: "terminal", label: "Terminal" },
  { tab: "agents", label: "Agents" },
  { tab: "preview", label: "Preview" },
];

export const PANEL_LABELS: Record<PanelTab, string> = Object.fromEntries(
  PANEL_TABS.map((entry) => [entry.tab, entry.label]),
) as Record<PanelTab, string>;

/** Each view's mark on the launcher. Modal's is its own brand mark; the rest are Lucide's. */
const PANEL_MARKS: Record<PanelTab, ReactNode> = {
  modal: <ModalMark className="h-3.5 w-auto" />,
  review: <FileDiff className="size-4" aria-hidden="true" />,
  pullRequest: <GitPullRequest className="size-4" aria-hidden="true" />,
  terminal: <SquareTerminal className="size-4" aria-hidden="true" />,
  agents: <Diamond className="size-4" aria-hidden="true" />,
  preview: <Globe className="size-4" aria-hidden="true" />,
};

/** The list of views the panel opens on; choosing one opens it as a tab. */
function PanelLauncher({ onSelectTab }: { onSelectTab: (tab: PanelTab) => void }) {
  return (
    <nav
      aria-label="Views"
      data-testid="panel-launcher"
      className="flex min-h-0 flex-1 flex-col justify-center px-4 pb-16"
    >
      <ul className="flex flex-col gap-2">
        {PANEL_TABS.map((entry) => (
          <li key={entry.tab}>
            <button
              type="button"
              data-testid={`panel-open-${entry.tab}`}
              onClick={() => onSelectTab(entry.tab)}
              className="flex w-full items-center gap-3 rounded-md border border-border px-4 py-3 text-left text-[14px] text-text transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              <span className="flex w-5 shrink-0 items-center justify-center text-muted-foreground">
                {PANEL_MARKS[entry.tab]}
              </span>
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** What a not-yet-built pane says instead of rendering empty. */
const COMING: Record<Extract<PanelTab, "preview">, string> = {
  preview: "Previews are not available yet.",
};

export const PHASE_WORD: Record<SandboxPhase, string> = {
  none: "Not started",
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
};

const PHASE_TONE: Record<SandboxPhase, "positive" | "caution" | "danger" | "faint"> = {
  none: "faint",
  starting: "caution",
  running: "positive",
  stopped: "faint",
  failed: "danger",
};

/** `notice`: accepted but not finished, said in neutral words once the dialog has closed. */
export type StopOutcome =
  | { readonly ok: true; readonly notice?: string }
  | { readonly ok: false; readonly message: string };

export type KeepAliveOutcome =
  | { readonly ok: true; readonly expiresAt: string }
  | { readonly ok: false; readonly message: string };

export type SessionPanelProps = {
  readonly view: SessionView;
  /** The session the Review and Terminal panes fetch artifacts for. */
  readonly sessionId: string | null;
  /** The open tabs, in the order they were opened. Empty while the panel shows its list of views. */
  readonly open: readonly PanelTab[];
  /** The tab in front; `null` with no tab open, when the panel lists its views instead. */
  readonly active: PanelTab | null;
  /** What the Review pane is on; the screen owns it so a change card can open a turn. */
  readonly reviewTarget: ReviewTarget;
  /** Makes a tab active, opening it first if it is not among `open`. */
  readonly onSelectTab: (tab: PanelTab) => void;
  /** Closes one tab; the screen closes the panel when the last one goes. */
  readonly onCloseTab: (tab: PanelTab) => void;
  /** Closes the whole panel. */
  readonly onClose: () => void;
  readonly onReviewTargetChange: (target: ReviewTarget) => void;
  /** The Pull request tab's branch: named, or still the person's to choose. Absent on a read-only surface. */
  readonly branch?: BranchEditing | undefined;
  readonly sandbox: SandboxActionView | undefined;
  /** Stops the sandbox; resolves with the Worker's answer. Absent when no session can be stopped here. */
  readonly onStopSandbox?: () => Promise<StopOutcome>;
  /** Keeps the sandbox running for an hour; resolves with the Worker's answer. */
  readonly onKeepAlive?: () => Promise<KeepAliveOutcome>;
  /** What the Agents view shows and does; absent, it lists the subagents and nothing opens. */
  readonly agents?: Omit<AgentsPaneProps, "view" | "sessionId"> | undefined;
};

/** Why the generation stopped and any keep-alive: control-plane events, never sandbox text. */
export type SandboxFacts = Pick<SandboxView, "stop" | "keepAlive">;

/**
 * The sandbox's state in words: the phase, or why it stopped where the control
 * plane recorded a reason a person would act on.
 */
export function sandboxStateLabel(phase: SandboxPhase, facts?: SandboxFacts | undefined): string {
  const stopReason = phase === "stopped" || phase === "failed" ? facts?.stop?.reason : undefined;
  if (stopReason === "disappeared") {
    return "Lost";
  }
  if (phase === "stopped" && stopReason === "idle") {
    return "Stopped after going idle";
  }
  return PHASE_WORD[phase];
}

/** When a running sandbox's keep-alive ends; null with none, or one already past. */
export function keptAliveUntil(
  phase: SandboxPhase,
  facts: SandboxFacts | undefined,
  now: number,
): string | null {
  const until = facts?.keepAlive?.expiresAt ?? null;
  return phase === "running" && until !== null && Date.parse(until) > now ? until : null;
}

type KeepAliveNotice = { readonly tone: "positive" | "danger"; readonly text: string };

/** The keep-alive request's own state, so the button and its answer line can sit apart. */
function useKeepAlive() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<KeepAliveNotice | null>(null);

  async function keep(request: () => Promise<KeepAliveOutcome>) {
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await request();
      setNotice(
        outcome.ok
          ? { tone: "positive", text: `Kept alive until ${formatClockTime(outcome.expiresAt)}` }
          : { tone: "danger", text: outcome.message },
      );
    } catch {
      // A caller-supplied request may throw; the button must not stay stuck.
      setNotice({ tone: "danger", text: "OnCue couldn't reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return { busy, notice, keep };
}

function StopSandboxButton({
  onStop,
  onNotice,
}: {
  onStop: () => Promise<StopOutcome>;
  onNotice: (notice: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const outcome = await onStop();
    setBusy(false);
    if (outcome.ok) {
      onNotice(outcome.notice ?? null);
      setOpen(false);
      return;
    }
    setError(outcome.message);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={cn(ROW_ACTION, "border border-border text-danger hover:text-danger")}
        data-testid="stop-sandbox"
      >
        Stop sandbox
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid="stop-sandbox-dialog">
        <DialogHeader>
          <DialogTitle className="font-semibold text-[15px] text-text">
            Stop this sandbox?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground leading-6">
            This ends the sandbox running in your Modal account and cancels the current run. Work
            inside it that has not been checkpointed is lost. The session, its timeline, and its
            branch stay.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <p className={cn("mt-3 text-[12px]", TONE_TEXT_CLASS.danger)} role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="mt-4 flex justify-end gap-2">
          <DialogClose className={ROW_ACTION}>Keep running</DialogClose>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
            data-testid="stop-sandbox-confirm"
            className={cn(DANGER_ACTION, "px-3 py-1.5 text-[12px]")}
          >
            {busy ? "Stopping…" : "Stop sandbox"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Only stderr is coloured; the controller's timings are facts, not warnings.
const OUTPUT_TAG_CLASS: Record<SandboxActionView["output"][number]["stream"], string> = {
  stdout: "text-faint",
  stderr: "text-caution",
  system: "text-faint",
  controller: "text-faint",
};

/** A collapsible section; its content stays in the document while closed. */
function Disclosure({
  title,
  summary,
  testId,
  children,
}: {
  title: string;
  summary: string | null;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId} data-open={open}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md py-2 pr-1 pl-1 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">
        <span className="shrink-0 font-medium text-[13px] text-text">{title}</span>
        {summary === null ? null : (
          <span className="min-w-0 truncate text-[12px] text-faint">· {summary}</span>
        )}
        <ChevronDown
          className="ml-auto size-3.5 shrink-0 text-faint transition-transform group-data-[panel-open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      {open ? (
        <CollapsibleContent>
          <div className="pt-1 pb-2">{children}</div>
        </CollapsibleContent>
      ) : (
        <div hidden>{children}</div>
      )}
    </Collapsible>
  );
}

function ModalTab({
  sandbox,
  facts,
  onStopSandbox,
  onKeepAlive,
}: {
  sandbox: SandboxActionView | undefined;
  facts: SandboxFacts;
  onStopSandbox?: (() => Promise<StopOutcome>) | undefined;
  onKeepAlive?: (() => Promise<KeepAliveOutcome>) | undefined;
}) {
  const phase = sandboxPhaseOf(sandbox);
  const now = useNow(phase === "running");
  const runningMs = sandboxRunningMs(sandbox, now);
  const keptUntil = keptAliveUntil(phase, facts, now);
  const steps = sandbox === undefined ? [] : sandboxSteps(sandbox);
  const canStop = onStopSandbox !== undefined && (phase === "running" || phase === "starting");
  // The route answers 409 unless the sandbox is running.
  const canKeepAlive = onKeepAlive !== undefined && phase === "running";
  const keepAlive = useKeepAlive();
  // Shown only while the sandbox still reads as running.
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const lastStep = steps.at(-1) ?? null;
  const lineCount = sandbox?.output.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="panel-modal">
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <ModalMark className="h-4 w-auto" />
          <span className="font-medium text-[14px] text-text">Modal</span>
          <span
            className={cn(
              "text-[12px]",
              TONE_TEXT_CLASS[PHASE_TONE[phase]],
              phase === "starting" ? "shimmer" : "",
            )}
            data-testid="panel-modal-phase"
          >
            {sandboxStateLabel(phase, facts)}
          </span>
        </div>
        {sandbox === undefined ? null : (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            {runningMs === null ? null : (
              <>
                <dt className="text-muted-foreground">
                  {phase === "running" ? "Running for" : "Ran for"}
                </dt>
                <dd className="font-mono text-text tabular-nums" data-testid="panel-modal-duration">
                  {formatElapsed(runningMs)}
                </dd>
              </>
            )}
            {keptUntil === null ? null : (
              <>
                <dt className="text-muted-foreground">Kept alive until</dt>
                <dd className="text-text tabular-nums" data-testid="panel-modal-kept-alive">
                  {formatClockTime(keptUntil)}
                </dd>
              </>
            )}
            {sandbox.providerSandboxId === null ? null : (
              <>
                <dt className="text-muted-foreground">Sandbox</dt>
                <dd className="truncate font-mono text-text">{sandbox.providerSandboxId}</dd>
              </>
            )}
          </dl>
        )}
        {canStop || canKeepAlive || keepAlive.notice !== null ? (
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {canKeepAlive ? (
                <button
                  type="button"
                  data-testid="keep-sandbox-alive"
                  disabled={keepAlive.busy}
                  onClick={() => void keepAlive.keep(onKeepAlive)}
                  className={cn(ROW_ACTION, "border border-border text-text")}
                >
                  Keep running for an hour
                </button>
              ) : null}
              {canStop ? (
                <StopSandboxButton onStop={onStopSandbox} onNotice={setStopNotice} />
              ) : null}
            </div>
            {canStop && stopNotice !== null ? (
              <p
                data-testid="stop-sandbox-notice"
                role="status"
                className="text-[12px] text-muted-foreground"
              >
                {stopNotice}
              </p>
            ) : null}
            {keepAlive.notice === null ? null : (
              <p
                data-testid="keep-sandbox-alive-notice"
                role={keepAlive.notice.tone === "danger" ? "alert" : "status"}
                className={cn("text-[12px]", TONE_TEXT_CLASS[keepAlive.notice.tone])}
              >
                {keepAlive.notice.text}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {sandbox === undefined ? (
        <p className="px-4 pt-2 text-[13px] text-muted-foreground">
          No sandbox has been asked for yet. Send a task and it starts here.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <div className="divide-y divide-border-soft border-border-soft border-t">
            <Disclosure
              title="What happened"
              summary={lastStep === null ? null : lastStep.label}
              testId="panel-modal-steps-section"
            >
              <ol className="space-y-1 pl-1" data-testid="panel-modal-steps">
                {keyed(steps).map(({ key, item: step }) => (
                  <li
                    key={key}
                    className="flex items-baseline gap-2 text-[13px] text-muted-foreground"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-text">{step.label}</span>
                      {step.detail === null ? null : (
                        <span className="text-faint"> · {step.detail}</span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                      {step.offset}
                    </span>
                  </li>
                ))}
              </ol>
            </Disclosure>

            <Disclosure
              title="Sandbox output"
              summary={
                lineCount === 0
                  ? "nothing printed yet"
                  : `${lineCount} ${lineCount === 1 ? "line" : "lines"}`
              }
              testId="panel-modal-output-section"
            >
              {lineCount === 0 ? (
                <p className="pl-1 text-[12px] text-faint">Nothing printed yet.</p>
              ) : (
                <pre
                  data-testid="panel-modal-output"
                  className="max-h-[50vh] overflow-auto rounded-lg border border-border-soft bg-surface px-3 py-2 font-mono text-[11px] text-text leading-5"
                >
                  {keyed(sandbox.output).map(({ key, item: line }) => (
                    <div key={key} className="flex gap-3">
                      <span
                        className={cn(
                          "w-[64px] shrink-0 select-none",
                          OUTPUT_TAG_CLASS[line.stream],
                        )}
                      >
                        {line.stream === "stdout" ? "" : line.stream}
                      </span>
                      <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
                    </div>
                  ))}
                </pre>
              )}
            </Disclosure>
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionPanel({
  view,
  sessionId,
  open,
  active,
  reviewTarget,
  onSelectTab,
  onCloseTab,
  onClose,
  onReviewTargetChange,
  sandbox,
  branch,
  onStopSandbox,
  onKeepAlive,
  agents,
}: SessionPanelProps) {
  const closed = PANEL_TABS.filter((entry) => !open.includes(entry.tab));
  const closeButton = (
    <button
      type="button"
      aria-label="Close panel"
      onClick={onClose}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-text"
    >
      <X className="size-4" aria-hidden="true" />
    </button>
  );
  if (active === null) {
    return (
      <aside data-testid="session-panel" className="flex h-full w-full min-w-0 flex-col bg-panel">
        <div className="flex h-12 shrink-0 items-center justify-end px-2">{closeButton}</div>
        <PanelLauncher onSelectTab={onSelectTab} />
      </aside>
    );
  }
  return (
    <aside data-testid="session-panel" className="flex h-full w-full min-w-0 flex-col bg-panel">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        {/*
          Plain buttons rather than a tablist: a tablist may hold only tabs
          (axe's aria-required-children), and each close lives inside its pill.
        */}
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          data-testid="panel-tabs"
        >
          {open.map((tab) => (
            <div key={tab} className="group/tab relative shrink-0">
              <button
                type="button"
                aria-current={tab === active ? "true" : undefined}
                data-testid={`panel-tab-${tab}`}
                onClick={() => onSelectTab(tab)}
                className={cn(
                  "rounded-lg py-1.5 pr-7 pl-3 text-[13px] transition-colors",
                  tab === active
                    ? "bg-hover-strong text-text"
                    : "text-muted-foreground hover:bg-hover hover:text-text",
                )}
              >
                {PANEL_LABELS[tab]}
              </button>
              <button
                type="button"
                aria-label={`Close ${PANEL_LABELS[tab]} tab`}
                onClick={() => onCloseTab(tab)}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-hover hover:text-text focus-visible:opacity-100 group-hover/tab:opacity-100"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          ))}
          {closed.length === 0 ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Open another tab"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-text"
              >
                <Plus className="size-4" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                sideOffset={6}
                className="min-w-[140px] border-border bg-popover p-1 shadow-xl"
              >
                {closed.map((entry) => (
                  <DropdownMenuItem
                    key={entry.tab}
                    onClick={() => onSelectTab(entry.tab)}
                    className="text-[13px] data-[highlighted]:bg-hover"
                  >
                    {entry.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {closeButton}
      </div>

      {active === "modal" ? (
        <ModalTab
          sandbox={sandbox}
          facts={view.sandbox}
          onStopSandbox={onStopSandbox}
          onKeepAlive={onKeepAlive}
        />
      ) : active === "review" ? (
        <ReviewPanel
          view={view}
          sessionId={sessionId}
          target={reviewTarget}
          onTargetChange={onReviewTargetChange}
        />
      ) : active === "pullRequest" ? (
        <PullRequestPane
          view={view}
          branch={branch ?? { named: null, slug: "", onSlugChange: () => undefined }}
        />
      ) : active === "terminal" ? (
        <TerminalPane view={view} sessionId={sessionId} />
      ) : active === "agents" ? (
        <AgentsPane
          view={view}
          sessionId={sessionId}
          {...(agents ?? {
            selectedAgentId: null,
            onSelectAgent: () => undefined,
            cleared: new Set<string>(),
            onClearFinished: () => undefined,
            modelConnections: [],
          })}
        />
      ) : (
        <div className="px-4 pt-4" data-testid="panel-preview">
          <p className="font-medium text-[13px] text-text">No preview yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{COMING[active]}</p>
        </div>
      )}
    </aside>
  );
}
