import { describe, expect, it } from "vitest";
import type { GitHubStuckReason, SetupState } from "@/lib/api/setup";
import { setupScreenOf } from "./setup-step";

const CONNECT_GITHUB: SetupState = { kind: "connect_github", installUrl: "https://x" };
const CONNECT_GITHUB_NO_URL: SetupState = { kind: "connect_github", installUrl: null };
const STUCK_REASONS: readonly GitHubStuckReason[] = [
  "cancelled",
  "no_repositories",
  "pending_approval",
];
const READY_NO_MODELS: SetupState = { kind: "ready", repositories: [], modelConnections: [] };
const CONNECT_MODAL_NO_MODELS: SetupState = { kind: "connect_modal", modelConnections: [] };
const CONNECT_MODAL_WITH_MODEL: SetupState = {
  kind: "connect_modal",
  modelConnections: [{ modelConnectionId: "m1", label: "Anthropic" }],
};
const READY_WITH_MODEL: SetupState = {
  kind: "ready",
  repositories: [],
  modelConnections: [{ modelConnectionId: "m1", label: "Anthropic" }],
};

describe("setupScreenOf", () => {
  it("maps connect_github to connect_github regardless of installUrl or context", () => {
    for (const on of ["setup", "shell"] as const) {
      expect(setupScreenOf(CONNECT_GITHUB, on)).toEqual({
        kind: "connect_github",
        installUrl: "https://x",
      });
      expect(setupScreenOf(CONNECT_GITHUB_NO_URL, on)).toEqual({
        kind: "connect_github",
        installUrl: null,
      });
    }
  });

  it("maps github_stuck to github_stuck, carrying the reason, regardless of context", () => {
    for (const on of ["setup", "shell"] as const) {
      for (const reason of STUCK_REASONS) {
        expect(setupScreenOf({ kind: "github_stuck", reason }, on)).toEqual({
          kind: "github_stuck",
          reason,
        });
      }
    }
  });

  it("is always home for ready on shell, even with zero model connections", () => {
    expect(setupScreenOf(READY_NO_MODELS, "shell")).toEqual({ kind: "home" });
    expect(setupScreenOf(READY_WITH_MODEL, "shell")).toEqual({ kind: "home" });
  });

  it("is add_model for ready with zero model connections on setup", () => {
    expect(setupScreenOf(READY_NO_MODELS, "setup")).toEqual({ kind: "add_model" });
  });

  it("is home for ready with at least one model connection on setup", () => {
    expect(setupScreenOf(READY_WITH_MODEL, "setup")).toEqual({ kind: "home" });
  });

  // `SetupGate` redirects on anything but `home`, so this makes Modal mandatory.
  it("is never home for connect_modal on shell, whatever the model list holds", () => {
    expect(setupScreenOf(CONNECT_MODAL_NO_MODELS, "shell")).toEqual({ kind: "connect_modal" });
    expect(setupScreenOf(CONNECT_MODAL_WITH_MODEL, "shell")).toEqual({ kind: "connect_modal" });
  });

  // GitHub, then the skippable model key, then Modal; "Skip for now" switches to "shell".
  it("offers the model step before Modal on setup when there is no model connection", () => {
    expect(setupScreenOf(CONNECT_MODAL_NO_MODELS, "setup")).toEqual({ kind: "add_model" });
  });

  it("goes straight to Modal on setup when a model connection already exists", () => {
    expect(setupScreenOf(CONNECT_MODAL_WITH_MODEL, "setup")).toEqual({ kind: "connect_modal" });
  });
});
