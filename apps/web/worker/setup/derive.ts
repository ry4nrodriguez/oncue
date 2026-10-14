// Record 13's first-run setup rule, shared by `/api/me` and the GitHub read.
// Three steps in order of dependence: connect GitHub (mandatory), add a model
// connection (skippable; without one a local session runs the scripted model
// and a hosted create is refused), and connect Modal (mandatory). Without
// either mandatory step, a composer that looks ready would fail on submit.

import type { ConnectionStatus } from "../broker/connections";
import type { ProviderId } from "../broker/providers/adapter";
import type { ModelSpec } from "../broker/providers/catalog";

export type GitHubStuckReason = "cancelled" | "no_repositories" | "pending_approval";

export interface RepositorySummary {
  readonly repositoryConnectionId: string;
  readonly fullName: string;
}

export interface ModelConnectionSummary {
  readonly modelConnectionId: string;
  readonly label: string;
  /** Whose key this is, so the composer can show that provider's mark. */
  readonly provider: ProviderId;
  /**
   * The provider's `defaultModel.modelId`, the value the broker builds a run's
   * `ModelRecord` from. The browser never chooses a model id; it reads this back.
   */
  readonly modelId: string;
  /** Every model this key may run on (the catalog), for the composer's picker. */
  readonly models: readonly ModelSpec[];
}

/** The statuses a key can be repaired from in place: every one but `active` and `revoked`. */
export type InactiveConnectionStatus = Exclude<ConnectionStatus, "active" | "revoked">;

/**
 * A connection whose key stopped working and can be replaced in place, which
 * keeps its id and its sessions (record 06). It is never offered for a new
 * session; Home names it so the picker and a banner can say what happened.
 */
export interface InactiveModelConnectionSummary {
  readonly modelConnectionId: string;
  readonly provider: ProviderId;
  readonly status: InactiveConnectionStatus;
  /** Active sessions on this key: each one's next model request needs it. */
  readonly activeSessions: number;
}

/** A connection whose credential stopped working is `none`: the screen is the same. */
export type ModalFact = "none" | "connected";

export type GitHubFact =
  | { readonly kind: "none" }
  | { readonly kind: "stuck"; readonly reason: GitHubStuckReason }
  | { readonly kind: "installed"; readonly repositories: readonly RepositorySummary[] };

export interface SetupFacts {
  readonly github: GitHubFact;
  readonly modelConnections: readonly ModelConnectionSummary[];
  /** Absent means none. */
  readonly inactiveModelConnections?: readonly InactiveModelConnectionSummary[];
  readonly modal: ModalFact;
}

export type SetupState =
  | { readonly kind: "connect_github"; readonly installUrl: string | null }
  | { readonly kind: "github_stuck"; readonly reason: GitHubStuckReason }
  /**
   * GitHub is done and Modal is not. It carries `modelConnections` because the
   * skippable model step sits between the two, and `setupScreenOf` shows it
   * first when the list is empty.
   */
  | {
      readonly kind: "connect_modal";
      readonly modelConnections: readonly ModelConnectionSummary[];
    }
  | {
      readonly kind: "ready";
      readonly repositories: readonly RepositorySummary[];
      readonly modelConnections: readonly ModelConnectionSummary[];
      /** Present only when a key has stopped working, so the usual body is unchanged. */
      readonly inactiveModelConnections?: readonly InactiveModelConnectionSummary[];
    };

/**
 *   none                     -> connect_github
 *   stuck                    -> github_stuck
 *   installed, []            -> github_stuck("no_repositories")   record 13 failure state 2
 *   installed, xs, no modal  -> connect_modal(models)
 *   installed, xs, modal     -> ready(xs, models), plus any keys that stopped working
 *
 * `installUrl` is always `null`: the install URL embeds a signed ten-minute
 * OAuth `state`, so it is minted per click by `POST /api/github/install-url`
 * rather than carried in a cacheable, replayable `/api/me`.
 */
export function deriveSetup(facts: SetupFacts): SetupState {
  const { github, modelConnections, modal } = facts;
  const inactive = facts.inactiveModelConnections ?? [];
  if (github.kind === "none") {
    return { kind: "connect_github", installUrl: null };
  }
  if (github.kind === "stuck") {
    return { kind: "github_stuck", reason: github.reason };
  }
  if (github.repositories.length === 0) {
    return { kind: "github_stuck", reason: "no_repositories" };
  }
  if (modal === "none") {
    return { kind: "connect_modal", modelConnections };
  }
  return {
    kind: "ready",
    repositories: github.repositories,
    modelConnections,
    ...(inactive.length === 0 ? {} : { inactiveModelConnections: inactive }),
  };
}
