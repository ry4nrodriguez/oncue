/**
 * Follows each command the screen sends to its answer. A send resolves on the
 * object's `command.acknowledged` or `command.rejected`, never on the socket
 * taking the frame, and every way it can fail to get one has its own outcome,
 * so no failure is silent.
 */
import type { CommandId, CommandType, SessionView } from "@oncue/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OutgoingCommand, SendOptions, SendResult } from "./use-session";

/**
 * How long a sent command waits for the object's answer before the screen
 * says so. A socket that dropped before the object read the frame never
 * answers; the retry reuses the command id, so a late answer is harmless.
 */
export const ANSWER_TIMEOUT_MS = 15_000;

export type CommandOutcome =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "rejected"; readonly reason: string; readonly detail: string }
  /** Written to a socket, and no answer came in time. */
  | { readonly kind: "unanswered" }
  /** No socket was open, and the command was not one to hold. */
  | { readonly kind: "not_sent" }
  /** Held for the next socket, then withdrawn before it left. */
  | { readonly kind: "withdrawn" };

/** Plain words for an outcome the person needs to act on; `null` for one they do not. */
export function outcomeProblem(outcome: CommandOutcome): string | null {
  switch (outcome.kind) {
    case "acknowledged":
    case "withdrawn":
      return null;
    case "rejected":
      return `Not accepted: ${outcome.detail}.`;
    case "unanswered":
      return "OnCue didn't answer in time. Try again.";
    case "not_sent":
      return "Not sent: OnCue is reconnecting. Try again in a moment.";
  }
}

/** A card's answer, sent as a command; the card is busy until the outcome and says what failed. */
export type AnswerHandler<A> = (answer: A) => Promise<CommandOutcome> | CommandOutcome;

export type Issued = {
  /** What the socket did with it. */
  readonly sent: SendResult | "answered";
  readonly outcome: Promise<CommandOutcome>;
};

type SendCommand = <T extends CommandType>(
  command: OutgoingCommand<T>,
  options?: SendOptions,
) => SendResult;

type Pending = {
  readonly resolve: (outcome: CommandOutcome) => void;
  timer: number | undefined;
};

type CommandAnswer = SessionView["commands"] extends ReadonlyMap<CommandId, infer A> ? A : never;

function outcomeOf(answer: CommandAnswer): CommandOutcome {
  if (answer.state === "acknowledged") {
    return { kind: "acknowledged" };
  }
  return {
    kind: "rejected",
    reason: answer.rejection?.reason ?? "rejected",
    detail: answer.rejection?.detail ?? "the session refused it",
  };
}

export function useCommands(
  commands: SessionView["commands"],
  sendCommand: SendCommand,
  cancelQueued: (commandId: string) => boolean,
) {
  const pending = useRef(new Map<string, Pending>());
  // `issue` checks for an answer that is already in, which a retry of an
  // answered command would otherwise wait for in vain.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());

  const settle = useCallback((commandId: string, outcome: CommandOutcome) => {
    const entry = pending.current.get(commandId);
    if (entry === undefined) {
      return;
    }
    pending.current.delete(commandId);
    window.clearTimeout(entry.timer);
    setQueued((current) => {
      if (!current.has(commandId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(commandId);
      return next;
    });
    entry.resolve(outcome);
  }, []);

  useEffect(() => {
    for (const commandId of [...pending.current.keys()]) {
      const answer = commands.get(commandId as CommandId);
      if (answer !== undefined) {
        settle(commandId, outcomeOf(answer));
      }
    }
  }, [commands, settle]);

  // Timers die with the screen; nothing resolves after it is gone.
  useEffect(() => {
    const entries = pending.current;
    return () => {
      for (const entry of entries.values()) {
        window.clearTimeout(entry.timer);
      }
      entries.clear();
    };
  }, []);

  const issue = useCallback(
    (command: OutgoingCommand, options: { readonly queue?: boolean } = {}): Issued => {
      const commandId = command.commandId;
      const known = commandsRef.current.get(commandId);
      if (known !== undefined) {
        return { sent: "answered", outcome: Promise.resolve(outcomeOf(known)) };
      }
      // A retry under the same id replaces the earlier wait.
      const earlier = pending.current.get(commandId);
      if (earlier !== undefined) {
        window.clearTimeout(earlier.timer);
        pending.current.delete(commandId);
        earlier.resolve({ kind: "unanswered" });
      }
      let resolveOutcome: (outcome: CommandOutcome) => void = () => {};
      const outcome = new Promise<CommandOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const entry: Pending = { resolve: resolveOutcome, timer: undefined };
      pending.current.set(commandId, entry);
      const startClock = () => {
        setQueued((current) => {
          if (!current.has(commandId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(commandId);
          return next;
        });
        entry.timer = window.setTimeout(
          () => settle(commandId, { kind: "unanswered" }),
          ANSWER_TIMEOUT_MS,
        );
      };
      const sent = sendCommand(command, { queue: options.queue === true, onSent: startClock });
      if (sent === "not_sent") {
        settle(commandId, { kind: "not_sent" });
      } else if (sent === "queued") {
        setQueued((current) => new Set(current).add(commandId));
      }
      return { sent, outcome };
    },
    [sendCommand, settle],
  );

  /** Withdraws a held command; false once it has left, since a sent command cannot be recalled. */
  const withdraw = useCallback(
    (commandId: string): boolean => {
      if (!cancelQueued(commandId)) {
        return false;
      }
      settle(commandId, { kind: "withdrawn" });
      return true;
    },
    [cancelQueued, settle],
  );

  // One command id per action until it gets an answer: a retry after
  // `unanswered` reuses it, so the object applies the action at most once.
  // Any other outcome means the next press is a new command.
  const retryIds = useRef(new Map<string, string>());
  const commandIdFor = useCallback((action: string): string => {
    const known = retryIds.current.get(action);
    if (known !== undefined) {
      return known;
    }
    const minted = crypto.randomUUID();
    retryIds.current.set(action, minted);
    return minted;
  }, []);
  const settleAction = useCallback((action: string, commandId: string, unanswered: boolean) => {
    if (!unanswered && retryIds.current.get(action) === commandId) {
      retryIds.current.delete(action);
    }
  }, []);

  /**
   * Issues `action`'s command under its retry id. `action` names everything
   * the payload depends on, so a retry under the same id is the same command.
   */
  const issueAction = useCallback(
    async (
      action: string,
      build: (commandId: string) => OutgoingCommand | null,
    ): Promise<CommandOutcome | null> => {
      const commandId = commandIdFor(action);
      const command = build(commandId);
      if (command === null) {
        settleAction(action, commandId, false);
        return null;
      }
      const outcome = await issue(command).outcome;
      settleAction(action, commandId, outcome.kind === "unanswered");
      return outcome;
    },
    [commandIdFor, settleAction, issue],
  );

  return { issue, withdraw, queued, issueAction, commandIdFor, settleAction };
}

/**
 * Busy while a command is out, its problem in words once it fails, and done
 * once the object accepted it, so a button that has done its work stays off
 * until the view moves on, which `subject` names: the run, approval, or
 * proposal the button acts on. A refused or lost command frees it again.
 */
export function useCommandAction(subject: string | number | null = null) {
  const [busy, setBusy] = useState(false);
  // The subject the last accepted command was for; done only while it is current.
  const [doneFor, setDoneFor] = useState<{ readonly subject: string | number | null } | null>(null);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const [problemFor, setProblemFor] = useState<{
    readonly subject: string | number | null;
    readonly text: string;
  } | null>(null);
  // A ref as well as state, so a second click in the same frame is refused
  // before the disabled button has rendered.
  const busyRef = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = useCallback(
    async (send: () => Promise<CommandOutcome | null> | CommandOutcome | null) => {
      if (busyRef.current) {
        return null;
      }
      busyRef.current = true;
      const sent = subjectRef.current;
      setBusy(true);
      setProblemFor(null);
      let outcome: CommandOutcome | null = null;
      try {
        outcome = await send();
      } finally {
        busyRef.current = false;
        if (live.current) {
          setBusy(false);
          setDoneFor(outcome?.kind === "acknowledged" ? { subject: sent } : null);
          const text = outcome === null ? null : outcomeProblem(outcome);
          setProblemFor(text === null ? null : { subject: sent, text });
        }
      }
      return outcome;
    },
    [],
  );
  const done = doneFor !== null && doneFor.subject === subject;
  const problem = problemFor !== null && problemFor.subject === subject ? problemFor.text : null;
  return { busy: busy || done, problem, run };
}
