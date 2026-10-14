/**
 * "Skip for now" on the optional model step, remembered for the tab so a
 * reload or a `SetupGate` redirect on the Modal step does not re-ask.
 * `sessionStorage`, not `localStorage`: a new tab should offer the step again.
 * Every access is guarded; a lost skip costs one click, never an error.
 */
const MODEL_STEP_SKIPPED_KEY = "oncue.setup.model-step-skipped";

export function readModelStepSkipped(): boolean {
  try {
    return window.sessionStorage.getItem(MODEL_STEP_SKIPPED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeModelStepSkipped(): void {
  try {
    window.sessionStorage.setItem(MODEL_STEP_SKIPPED_KEY, "true");
  } catch {
    // As above: the skip is a convenience, and losing it costs one click.
  }
}
