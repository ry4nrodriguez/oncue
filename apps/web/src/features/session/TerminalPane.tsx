/**
 * The Terminal tab: a read-only view of the commands and checks that ran,
 * built from the session's events. It is not a shell; nothing here can send
 * input into the sandbox, since an interactive shell would cross the bridge
 * boundary.
 */
import type { CheckView, SessionView, ToolView } from "@oncue/protocol";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import { checkDisplayState } from "@/features/verification/check-display";
import { CHECK_STATE_WORDS } from "@/features/verification/outcomes";
import { checkStateClass, FullOutputLink } from "@/features/verification/TestsView";
import { cn } from "@/lib/utils";
import { keyed } from "./ActionRow";
import { FAILURE_SUMMARY, formatDuration, resultOutput, toolFailureCategory } from "./actions";
import { toolRowState } from "./Timeline";

type LiveToolOutput = NonNullable<ReturnType<SessionView["live"]["toolOutput"]["get"]>>;

export type ConsoleEntry =
  | { readonly kind: "tool"; readonly at: string; readonly tool: ToolView }
  | { readonly kind: "check"; readonly at: string; readonly check: CheckView };

/**
 * Everything that ran, oldest first, including only checks that have started.
 * The timestamps are ISO strings of one format, so they sort as text.
 */
export function consoleEntries(view: SessionView): readonly ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  for (const tool of view.tools.values()) {
    entries.push({ kind: "tool", at: tool.requestedAt, tool });
  }
  for (const check of view.verification.checks.values()) {
    const at = check.latest?.startedAt ?? check.attempts[0]?.startedAt ?? null;
    if (at !== null) {
      entries.push({ kind: "check", at, check });
    }
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/** The shell command for a shell call, else the runtime's title ("Read src/app.ts"). */
export function commandLine(tool: Pick<ToolView, "category" | "input" | "title">): string {
  if (tool.category === "shell" && typeof tool.input === "object" && tool.input !== null) {
    const command = (tool.input as { readonly command?: unknown }).command;
    if (typeof command === "string" && command.trim().length > 0) {
      return command;
    }
  }
  return tool.title;
}

/** Output as lines, dropping only a trailing empty line left by a final newline. */
function lines(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split("\n").filter((line, index, all) => line.length > 0 || index < all.length - 1);
}

function Output({ text, live }: { text: string; live: boolean }) {
  const rows = lines(text);
  if (rows.length === 0 && !live) {
    return null;
  }
  return (
    <pre
      data-testid="console-output"
      className="mt-1 whitespace-pre-wrap break-words pl-4 text-muted-foreground"
    >
      {keyed(rows).map(({ key, item }) => (
        <div key={key}>{item}</div>
      ))}
      {live ? (
        <span
          className="shimmer inline-block text-text"
          aria-hidden="true"
          data-testid="console-cursor"
        >
          ▍
        </span>
      ) : null}
    </pre>
  );
}

function ToolEntry({ tool, live }: { tool: ToolView; live: LiveToolOutput | undefined }) {
  const state = toolRowState(tool);
  const running = state === "running";
  // A settled call's output is in its durable result; the committed chunks are
  // the fallback when the result has none.
  const printed = resultOutput(tool.result);
  const committed = printed?.text ?? tool.output.map((chunk) => chunk.text).join("");
  // The live tail is stale once the call has settled.
  const text = running && live !== undefined ? committed + live.text : committed;
  const failure = toolFailureCategory(tool);
  const meta =
    state === "requested"
      ? "waiting"
      : running
        ? "running"
        : [
            tool.durationMs === null ? null : formatDuration(tool.durationMs),
            tool.exitCode === null ? null : `exit ${tool.exitCode}`,
            failure === null ? null : FAILURE_SUMMARY[failure],
          ]
            .filter((part): part is string => part !== null)
            .join(" · ");
  return (
    <div data-testid="console-entry" data-kind="tool" data-state={state}>
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 select-none text-accent-text" aria-hidden="true">
          $
        </span>
        <span className="min-w-0 flex-1 break-all text-text">{commandLine(tool)}</span>
        <span
          className={cn(
            "shrink-0 text-[11px]",
            state === "failed" ? TONE_TEXT_CLASS.danger : "text-faint",
            running ? "shimmer" : "",
          )}
        >
          {meta}
        </span>
      </div>
      <Output text={text} live={running} />
      {tool.failure === null ? null : (
        <p className={cn("mt-1 pl-4", TONE_TEXT_CLASS.danger)}>{tool.failure.errorText}</p>
      )}
      {printed === null && tool.outputDropped ? (
        <p className={cn("mt-1 pl-4 text-[11px]", TONE_TEXT_CLASS.caution)}>
          Some of this call's output is no longer available after a reconnect.
        </p>
      ) : null}
    </div>
  );
}

function CheckEntry({
  view,
  check,
  sessionId,
}: {
  view: SessionView;
  check: CheckView;
  sessionId: string | null;
}) {
  const runEnded = view.runs.get(check.runId)?.outcome != null;
  const state = checkDisplayState(check, runEnded);
  const result = check.latest?.result ?? null;
  const tone = checkStateClass(state);
  const meta = [
    CHECK_STATE_WORDS[state],
    result === null ? null : formatDuration(result.durationMs),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <div data-testid="console-entry" data-kind="check" data-state={state}>
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 select-none text-accent-text" aria-hidden="true">
          ▸
        </span>
        <span className="min-w-0 flex-1 break-all text-text">{check.name}</span>
        <span className={cn("shrink-0 text-[11px]", tone, state === "running" ? "shimmer" : "")}>
          {meta}
        </span>
      </div>
      {result === null ? null : (
        <div className="mt-1 flex flex-col gap-1 pl-4 text-muted-foreground">
          {result.summary.length === 0 ? null : (
            <pre className="whitespace-pre-wrap break-words">{result.summary}</pre>
          )}
          <span className="font-sans text-[12px]">
            <FullOutputLink sessionId={sessionId} result={result} describe={check.name} />
          </span>
        </div>
      )}
    </div>
  );
}

export function TerminalPane({ view, sessionId }: { view: SessionView; sessionId: string | null }) {
  const entries = consoleEntries(view);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="panel-terminal">
      {entries.length === 0 ? (
        <p className="px-4 pt-4 text-[13px] text-muted-foreground" data-testid="console-empty">
          Nothing has run yet. Commands the agent runs, and the checks it triggers, appear here as
          they happen.
        </p>
      ) : (
        <Conversation className="flex-1">
          <ConversationContent className="flex flex-col gap-3 p-3 font-mono text-[12px] leading-5">
            {entries.map((entry) =>
              entry.kind === "tool" ? (
                <ToolEntry
                  key={`tool-${entry.tool.toolCallId}`}
                  tool={entry.tool}
                  live={view.live.toolOutput.get(entry.tool.toolCallId)}
                />
              ) : (
                <CheckEntry
                  key={`check-${entry.check.checkId}`}
                  view={view}
                  check={entry.check}
                  sessionId={sessionId}
                />
              ),
            )}
          </ConversationContent>
        </Conversation>
      )}
    </div>
  );
}
