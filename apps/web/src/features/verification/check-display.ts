/**
 * A check still `pending` or `running` when its run ended (a cancel) never
 * gets a result. `not_finished` is a display-only state for that case; it
 * never appears on the wire or in a state machine.
 */
import type { CheckView, VerificationCheckState } from "@oncue/protocol";

export type CheckDisplayState = VerificationCheckState | "not_finished";

export function checkDisplayState(check: CheckView, runEnded: boolean): CheckDisplayState {
  if (runEnded && (check.status === "pending" || check.status === "running")) {
    return "not_finished";
  }
  return check.status;
}
