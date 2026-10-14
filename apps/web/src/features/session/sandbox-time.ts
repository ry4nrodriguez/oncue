/** Durations and step offsets for the sandbox row and the Modal panel. */
import type { SandboxActionView, SandboxStepView, SessionView } from "@oncue/protocol";
import { useEffect, useState } from "react";

/**
 * The current generation's row, or the highest one when no lifecycle event has
 * set the current generation (only a fixture starting mid-life does that).
 */
export function currentSandboxAction(view: SessionView): SandboxActionView | undefined {
  const current = view.sandboxActions.get(view.sandbox.generation);
  if (current !== undefined) {
    return current;
  }
  let latest: SandboxActionView | undefined;
  for (const action of view.sandboxActions.values()) {
    if (latest === undefined || action.generation > latest.generation) {
      latest = action;
    }
  }
  return latest;
}

/** The sandbox as the rail, the composer strip, and the panel describe it. */
export type SandboxPhase = "none" | "starting" | "running" | "stopped" | "failed";

export function sandboxPhaseOf(action: SandboxActionView | undefined): SandboxPhase {
  if (action === undefined) {
    return "none";
  }
  if (action.state === "failed") {
    return "failed";
  }
  if (action.endedAt !== null) {
    return "stopped";
  }
  return action.runningSince === null ? "starting" : "running";
}

/** The steps between asking for a sandbox and OpenCode answering its health check. */
const TRANSITION_STEPS: ReadonlySet<SandboxActionView["step"]> = new Set([
  "requested",
  "provisioning",
  "attached",
  "connected",
  "reconnecting",
]);

/** Whether the sandbox is between the request and the agent runtime reporting ready. */
export function sandboxInTransition(action: SandboxActionView | undefined): boolean {
  const phase = sandboxPhaseOf(action);
  if (phase === "starting") {
    return true;
  }
  return phase === "running" && action !== undefined && TRANSITION_STEPS.has(action.step);
}

/**
 * Milliseconds the sandbox has been running: live against `now` while it
 * runs, fixed at the total once it has ended, `null` before it started.
 */
export function sandboxRunningMs(
  action: SandboxActionView | undefined,
  now: number,
): number | null {
  if (action === undefined || action.runningSince === null) {
    return null;
  }
  const start = Date.parse(action.runningSince);
  const end = action.endedAt === null ? now : Date.parse(action.endedAt);
  return Math.max(0, end - start);
}

/** "0s", "+2.4s", "+1m 3s": each step relative to the first, for the sequence list. */
export function stepOffsets(steps: readonly SandboxStepView[]): readonly string[] {
  const first = steps[0];
  if (first === undefined) {
    return [];
  }
  const origin = Date.parse(first.at);
  return steps.map((step, index) => {
    if (index === 0) {
      return "0s";
    }
    return `+${formatElapsed(Math.max(0, Date.parse(step.at) - origin))}`;
  });
}

/** Whole seconds under a minute, minutes and seconds above: a clock, not a stopwatch. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (ms < 10_000) {
    return `${Math.round(ms / 100) / 10}s`;
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "HH:MM" in the viewer's local time, for a deadline such as a keep-alive's expiry. */
export function formatClockTime(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The current time, re-read once a second while `active`; inactive, it does not re-render. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [active]);
  return now;
}
