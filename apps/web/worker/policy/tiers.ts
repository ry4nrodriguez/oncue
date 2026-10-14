// Record 09's four permission tiers. They cover what the control plane
// performs or supplies, where an approval is a hard gate because the approved
// thing (a secret, a push token) does not reach the sandbox until the object
// sends it, and the harness's own permission asks, which the object answers
// but which bind only the agent's cooperation: the agent has a shell, and the
// sandbox is the boundary. Tier 4 is enforced by credentials that cannot do
// the thing; this only stops a card being offered for it.

import type { PayloadOf } from "@oncue/protocol";

export type ApprovalCategory = PayloadOf<"approval.requested">["category"];
export type ExpiryEffect = PayloadOf<"approval.expired">["effect"];

export interface TierApproval {
  readonly category: Exclude<ApprovalCategory, "other">;
  /** False for a tier 3 action this version has no mechanism to approve. */
  readonly offered: boolean;
}

export interface TierAction {
  readonly action: string;
  readonly tier: 1 | 2 | 3 | 4;
  /** Set on tier 3 actions and on no other. */
  readonly approval: TierApproval | null;
}

function automatic(action: string): TierAction {
  return { action, tier: 1, approval: null };
}

function underGitPolicy(action: string): TierAction {
  return { action, tier: 2, approval: null };
}

function approvable(action: string, approval: TierApproval): TierAction {
  return { action, tier: 3, approval };
}

function prohibited(action: string): TierAction {
  return { action, tier: 4, approval: null };
}

/** Record 09, "Permission tiers", in the record's own order. */
export const TIER_ACTIONS: readonly TierAction[] = [
  automatic("read_checkout_files"),
  automatic("search_repository"),
  automatic("edit_files_on_session_branch"),
  automatic("run_repository_setup_commands"),
  automatic("install_development_dependencies"),
  automatic("start_declared_local_services"),
  automatic("run_tests_lint_typecheck_build"),
  automatic("use_development_browser"),
  automatic("collect_verification_artifacts"),
  automatic("review_local_git_state"),
  automatic("create_local_commits"),

  underGitPolicy("push_session_branch"),
  underGitPolicy("create_or_update_draft_pull_request"),
  underGitPolicy("read_checks_and_pull_request_state"),

  approvable("supply_optional_development_secret", {
    category: "development_secret",
    offered: true,
  }),
  // The harness's own asks (record 09, "Agent permissions"). The session's
  // approval mode and saved rules answer them, or the user's card does.
  approvable("use_files_outside_project", { category: "outside_project", offered: true }),
  approvable("read_secret_file", { category: "secret_file", offered: true }),
  approvable("repeat_identical_action", { category: "repeated_action", offered: true }),
  // A subagent's start (record 12): a second model conversation, billed to the
  // run's connection, which the bridge bounds before it asks.
  approvable("start_subagent", { category: "start_subagent", offered: true }),
  approvable("answer_other_harness_request", { category: "other_request", offered: true }),
  // The network policy is fixed when a sandbox is created, and no external
  // integration exists, so nothing could act on an approval of these three.
  approvable("enable_external_connection", {
    category: "external_connection",
    offered: false,
  }),
  approvable("expand_network_policy", {
    category: "network_expansion",
    offered: false,
  }),
  approvable("act_on_external_system", {
    category: "external_action",
    offered: false,
  }),

  prohibited("use_production_data_or_credentials"),
  prohibited("push_to_base_branch"),
  prohibited("force_push"),
  prohibited("merge_pull_request"),
  prohibited("delete_remote_branch_or_tag"),
  prohibited("create_release_or_deployment"),
  prohibited("change_repository_or_organization_settings"),
  prohibited("read_github_actions_secrets"),
  prohibited("access_another_users_resources"),
  prohibited("access_oncue_administrative_services"),
];

/** The categories a card can exist for. The interface shows no other. */
export const OFFERED_APPROVAL_CATEGORIES: readonly ApprovalCategory[] = TIER_ACTIONS.flatMap(
  (entry) => (entry.approval?.offered === true ? [entry.approval.category] : []),
);

export type TierDecision =
  | { readonly kind: "automatic" }
  | { readonly kind: "follows_git_policy" }
  | {
      readonly kind: "ask";
      readonly category: TierApproval["category"];
    }
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly reason: "not_offered" | "prohibited" | "unknown_action" };

/**
 * `approved` is the object's own record of the user's approval, never a
 * sandbox's word. It matters only to an offered tier 3 action.
 */
export function decideAction(
  action: string,
  backing: { readonly approved: boolean },
): TierDecision {
  const entry = TIER_ACTIONS.find((candidate) => candidate.action === action);
  if (entry === undefined) {
    return { kind: "refuse", reason: "unknown_action" };
  }
  if (entry.tier === 4) {
    return { kind: "refuse", reason: "prohibited" };
  }
  if (entry.approval === null) {
    return entry.tier === 1 ? { kind: "automatic" } : { kind: "follows_git_policy" };
  }
  if (!entry.approval.offered) {
    return { kind: "refuse", reason: "not_offered" };
  }
  if (backing.approved) {
    return { kind: "allow" };
  }
  return { kind: "ask", category: entry.approval.category };
}

/** The tier 3 action a sandbox's approval category names, or null for `other`, which names none. */
export function actionForCategory(category: ApprovalCategory): string | null {
  const entry = TIER_ACTIONS.find((candidate) => candidate.approval?.category === category);
  return entry === undefined ? null : entry.action;
}
