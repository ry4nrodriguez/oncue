// Run admission from record 03's `platform_control` row. Admission fails
// closed until that row can be read. `decideAdmission` is pure so the Worker
// and the session object share one decision.

import { atMostOne } from "./sql";

export type AdmissionReason =
  | "control_unreadable"
  | "admission_stopped"
  | "workspace_cap_reached"
  | "platform_cap_reached";

export type AdmissionDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "refuse"; readonly reason: AdmissionReason };

export interface PlatformControl {
  readonly runAdmission: "open" | "stopped";
  readonly platformConcurrentSandboxCap: number;
  readonly workspaceConcurrentSandboxCap: number;
}

/** Concurrent-sandbox counts the caller already read. */
export interface AdmissionCounts {
  readonly workspaceActiveSandboxCount: number;
  readonly platformActiveSandboxCount: number;
}

/**
 * `control === null` means the state could not be read, so it fails closed.
 * Then the stop switch, the workspace cap, and the platform cap, so a caller
 * learns the most specific reason.
 */
export function decideAdmission(
  control: PlatformControl | null,
  counts: AdmissionCounts,
): AdmissionDecision {
  if (control === null) {
    return { kind: "refuse", reason: "control_unreadable" };
  }
  if (control.runAdmission === "stopped") {
    return { kind: "refuse", reason: "admission_stopped" };
  }
  if (counts.workspaceActiveSandboxCount >= control.workspaceConcurrentSandboxCap) {
    return { kind: "refuse", reason: "workspace_cap_reached" };
  }
  if (counts.platformActiveSandboxCount >= control.platformConcurrentSandboxCap) {
    return { kind: "refuse", reason: "platform_cap_reached" };
  }
  return { kind: "admit" };
}

type PlatformControlRow = {
  readonly run_admission: unknown;
  readonly platform_concurrent_sandbox_cap: unknown;
  readonly workspace_concurrent_sandbox_cap: unknown;
};

// A malformed row counts as no row: both fail closed.
function toPlatformControl(row: PlatformControlRow): PlatformControl | null {
  if (row.run_admission !== "open" && row.run_admission !== "stopped") {
    return null;
  }
  if (
    typeof row.platform_concurrent_sandbox_cap !== "number" ||
    typeof row.workspace_concurrent_sandbox_cap !== "number"
  ) {
    return null;
  }
  return {
    runAdmission: row.run_admission,
    platformConcurrentSandboxCap: row.platform_concurrent_sandbox_cap,
    workspaceConcurrentSandboxCap: row.workspace_concurrent_sandbox_cap,
  };
}

/** A missing row, a malformed row, and a thrown query all read as `null` (fail closed). */
export async function readPlatformControl(db: D1Database): Promise<PlatformControl | null> {
  try {
    const statement = db.prepare(
      "SELECT run_admission, platform_concurrent_sandbox_cap, workspace_concurrent_sandbox_cap FROM platform_control WHERE id = 1",
    );
    const result = await atMostOne<PlatformControlRow>(statement);
    if (result.kind === "absent") {
      return null;
    }
    return toPlatformControl(result.row);
  } catch {
    return null;
  }
}
