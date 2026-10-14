import { describe, expect, it } from "vitest";
import {
  actionForCategory,
  decideAction,
  OFFERED_APPROVAL_CATEGORIES,
  TIER_ACTIONS,
  type TierAction,
} from "./tiers";

function actionsOfTier(tier: TierAction["tier"]): readonly TierAction[] {
  return TIER_ACTIONS.filter((entry) => entry.tier === tier);
}

describe("the tier table", () => {
  it("transcribes record 09: eleven automatic, three under Git policy, nine approvable, ten prohibited", () => {
    expect(actionsOfTier(1)).toHaveLength(11);
    expect(actionsOfTier(2)).toHaveLength(3);
    expect(actionsOfTier(3)).toHaveLength(9);
    expect(actionsOfTier(4)).toHaveLength(10);
  });

  it("names every action once", () => {
    const names = TIER_ACTIONS.map((entry) => entry.action);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives an approval category to tier 3 actions and to no other", () => {
    for (const entry of TIER_ACTIONS) {
      expect(entry.approval !== null, entry.action).toBe(entry.tier === 3);
    }
  });

  it("offers a development secret and the harness's five permission asks, and nothing that acts outside the sandbox", () => {
    const offered = actionsOfTier(3).filter((entry) => entry.approval?.offered === true);
    expect(offered.map((entry) => entry.action)).toEqual([
      "supply_optional_development_secret",
      "use_files_outside_project",
      "read_secret_file",
      "repeat_identical_action",
      "start_subagent",
      "answer_other_harness_request",
    ]);
    expect(OFFERED_APPROVAL_CATEGORIES).toEqual([
      "development_secret",
      "outside_project",
      "secret_file",
      "repeated_action",
      "start_subagent",
      "other_request",
    ]);
  });

  it("keeps record 09's hard limits unavailable whatever a card says", () => {
    for (const action of [
      "force_push",
      "push_to_base_branch",
      "merge_pull_request",
      "delete_remote_branch_or_tag",
      "create_release_or_deployment",
      "change_repository_or_organization_settings",
      "read_github_actions_secrets",
    ]) {
      expect(decideAction(action, { approved: true })).toEqual({
        kind: "refuse",
        reason: "prohibited",
      });
    }
  });
});

describe("deciding an action", () => {
  it.each(actionsOfTier(1).map((entry) => entry.action))("tier 1 %s is automatic", (action) => {
    expect(decideAction(action, { approved: false })).toEqual({ kind: "automatic" });
  });

  it.each(actionsOfTier(2).map((entry) => entry.action))(
    "tier 2 %s follows the session's Git policy, approval or not",
    (action) => {
      expect(decideAction(action, { approved: false })).toEqual({ kind: "follows_git_policy" });
      expect(decideAction(action, { approved: true })).toEqual({ kind: "follows_git_policy" });
    },
  );

  it("the offered tier 3 action asks first and is allowed only once approved", () => {
    expect(decideAction("supply_optional_development_secret", { approved: false })).toEqual({
      kind: "ask",
      category: "development_secret",
    });
    expect(decideAction("supply_optional_development_secret", { approved: true })).toEqual({
      kind: "allow",
    });
  });

  it.each(
    actionsOfTier(3)
      .filter((entry) => entry.approval?.offered !== true)
      .map((entry) => entry.action),
  )("tier 3 %s is not offered in this version, approved or not", (action) => {
    expect(decideAction(action, { approved: false })).toEqual({
      kind: "refuse",
      reason: "not_offered",
    });
    expect(decideAction(action, { approved: true })).toEqual({
      kind: "refuse",
      reason: "not_offered",
    });
  });

  it.each(actionsOfTier(4).map((entry) => entry.action))(
    "tier 4 %s is refused, and an approval changes nothing",
    (action) => {
      expect(decideAction(action, { approved: false })).toEqual({
        kind: "refuse",
        reason: "prohibited",
      });
      expect(decideAction(action, { approved: true })).toEqual({
        kind: "refuse",
        reason: "prohibited",
      });
    },
  );

  it("refuses an action the table has never heard of", () => {
    expect(decideAction("launch_the_missiles", { approved: true })).toEqual({
      kind: "refuse",
      reason: "unknown_action",
    });
  });
});

describe("the action a sandbox's approval category names", () => {
  it("maps each category to its tier 3 action", () => {
    expect(actionForCategory("development_secret")).toBe("supply_optional_development_secret");
    expect(actionForCategory("external_connection")).toBe("enable_external_connection");
    expect(actionForCategory("network_expansion")).toBe("expand_network_policy");
    expect(actionForCategory("external_action")).toBe("act_on_external_system");
  });

  it("maps `other` to nothing, so it is refused as unknown", () => {
    expect(actionForCategory("other")).toBeNull();
  });
});
