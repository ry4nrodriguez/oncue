// The one place record 13's asymmetry between setup steps is decided, for both the shell and `/setup`.
import type { GitHubStuckReason, SetupState } from "@/lib/api/setup";

export type SetupScreen =
  | { readonly kind: "connect_github"; readonly installUrl: string | null }
  | { readonly kind: "github_stuck"; readonly reason: GitHubStuckReason }
  | { readonly kind: "add_model" }
  | { readonly kind: "connect_modal" }
  | { readonly kind: "home" };

/**
 * "shell" (the app shell): only `ready` is `home`; the mandatory GitHub and
 * Modal steps report a screen, so `SetupGate` redirects for either, and the
 * optional model step never does.
 *
 * "setup" (the `/setup` route): also offers the optional model step, between
 * GitHub and Modal, while no key exists. "Skip for now" switches to "shell".
 */
export function setupScreenOf(setup: SetupState, on: "setup" | "shell"): SetupScreen {
  if (setup.kind === "connect_github") {
    return { kind: "connect_github", installUrl: setup.installUrl };
  }
  if (setup.kind === "github_stuck") {
    return { kind: "github_stuck", reason: setup.reason };
  }
  if (on === "shell") {
    return setup.kind === "connect_modal" ? { kind: "connect_modal" } : { kind: "home" };
  }
  if (setup.modelConnections.length === 0) {
    return { kind: "add_model" };
  }
  return setup.kind === "connect_modal" ? { kind: "connect_modal" } : { kind: "home" };
}
