/**
 * Every sentence the Modal connection shows, in `Record`s over closed unions
 * so an unhandled case is a compile error. The wording follows Modal's
 * documentation:
 *
 * - The Starter plan is free with $30 of monthly credit, but Modal requires a
 *   payment method, so never say "no credit card".
 * - Service users are Team and Enterprise only. A Starter user pastes a
 *   personal token with full authority over the workspace, so the form
 *   recommends a dedicated workspace before the paste.
 * - A service user starts with No Access on every Environment; that is said
 *   before the user leaves for Modal and again in the failure.
 */

import type { StatusTone } from "@/features/status-tone";
import type { ModalConnectionStatus, ModalTestFailureReason } from "@/lib/api/modal-connection";

/** Where a user goes to create the token pair. */
export const MODAL_TOKEN_URL = "https://modal.com/settings/tokens";

export interface ModalStatusMeta {
  readonly label: string;
  readonly tone: StatusTone;
}

export const MODAL_STATUS_META: Record<ModalConnectionStatus, ModalStatusMeta> = {
  active: { label: "Connected", tone: "positive" },
  invalid: { label: "Not working", tone: "danger" },
};

/**
 * One plain sentence per failure, never Modal's own error text.
 * `no_environment_access` means a genuine credential with no role, as a fresh
 * service user has, so it names the fix instead of prompting a second token.
 */
export const MODAL_FAILURE_MESSAGE: Record<ModalTestFailureReason, string> = {
  invalid_credentials:
    "Modal didn't recognize that token pair. Check that you copied both halves of the same token, then try again.",
  no_environment_access:
    "Modal accepted the token but it can't see any Environment. A service user starts with No Access on every Environment — grant it a role on at least one in your Modal workspace settings, then try again.",
  unreachable: "OnCue couldn't reach Modal to check the token. Try again in a moment.",
  controller_unavailable:
    "OnCue can't check Modal credentials right now. This is on OnCue's side, not yours. Try again in a moment.",
};

/** What a user must know before leaving for Modal, shared by the setup step and the settings screen. */
export const CONNECT_MODAL_POINTS = [
  "Modal's Starter plan is free with $30 of compute credit a month, and Modal needs a payment method on file.",
  "A personal token has full authority over your whole Modal workspace. OnCue uses it to create, inspect, and stop sandboxes, so consider a Modal workspace just for OnCue.",
  "A service user starts with No Access on every Environment. Grant it a role before you paste its token.",
] as const;
