/**
 * The pure decision core behind the sign-in gate and blocked screen. Nothing
 * here touches Clerk, `fetch`, or the DOM; `AuthGate.tsx` wires them in.
 */

import { parseSetupState, type SetupState } from "@/lib/api/setup";

export type MeResult =
  | {
      readonly kind: "allowed";
      readonly userId: string;
      readonly workspaceId: string;
      readonly setup: SetupState;
    }
  | { readonly kind: "blocked"; readonly clerkSubject: string | null };

export type GateState =
  | { readonly kind: "loading" }
  /** `/api/me` has not answered usably yet; the gate keeps retrying. */
  | { readonly kind: "failed" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "blocked"; readonly clerkSubject: string | null }
  | {
      readonly kind: "allowed";
      readonly userId: string;
      readonly workspaceId: string;
      readonly setup: SetupState;
    };

/**
 * `me` is the last usable `/api/me` answer, kept through a failed refetch, so
 * a failure after the app is on screen never replaces it with the error.
 */
export function decideGateState(
  clerkLoaded: boolean,
  isSignedIn: boolean,
  me: MeResult | null,
  failed = false,
): GateState {
  if (!clerkLoaded) {
    return { kind: "loading" };
  }
  if (!isSignedIn) {
    return { kind: "signed_out" };
  }
  if (me === null) {
    return failed ? { kind: "failed" } : { kind: "loading" };
  }
  if (me.kind === "blocked") {
    return { kind: "blocked", clerkSubject: me.clerkSubject };
  }
  return { kind: "allowed", userId: me.userId, workspaceId: me.workspaceId, setup: me.setup };
}

/**
 * `/api/me`'s two response shapes (`worker/routes/me.ts`), read defensively:
 * anything else becomes `null`, which the gate treats as a failed request.
 */
export function parseMeResponse(status: number, body: unknown): MeResult | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (status === 200) {
    if (typeof record.userId === "string" && typeof record.workspaceId === "string") {
      const setup = parseSetupState(record.setup);
      if (setup === null) {
        return null;
      }
      return { kind: "allowed", userId: record.userId, workspaceId: record.workspaceId, setup };
    }
    return null;
  }
  if (status === 403) {
    const clerkSubject = typeof record.clerkSubject === "string" ? record.clerkSubject : null;
    return { kind: "blocked", clerkSubject };
  }
  return null;
}

/** A `/api/me` request with no answer by now is abandoned and counts as a failure. */
export const ME_TIMEOUT_MS = 10_000;

/** The first retry after a failed `/api/me` is quick; later ones back off to this cap. */
export const ME_RETRY_CAP_MS = 30_000;

/** The wait before the gate's `failures`th automatic retry, doubling from one second. */
export function meRetryDelay(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), ME_RETRY_CAP_MS);
}

export const ME_FAILED_MESSAGE = "OnCue couldn't reach the server.";

export const BLOCKED_MESSAGE = "Your account is not enabled on this OnCue.";

/**
 * Local only: the caller's own Clerk subject and where to paste it. The
 * server enforces this by omitting `clerkSubject` outside `ONCUE_ENV=local`.
 */
export function blockedLocalHint(clerkSubject: string | null): string | null {
  if (clerkSubject === null) {
    return null;
  }
  return `Add "${clerkSubject}" to ONCUE_USER_ALLOWLIST in apps/web/.dev.vars, then sign in again.`;
}
