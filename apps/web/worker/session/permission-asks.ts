// The harness's own permission asks (record 09, "Agent permissions"); pure,
// no storage or clock. The sandbox is trusted for the category, the resource
// it names, and the kind of tool: the object writes every word on the card,
// and decides from the session's mode and rules and the workspace's, never
// from anything the sandbox says about the user.

import {
  type ApprovalMode,
  type ApprovalScope,
  type PayloadOf,
  PERMISSION_CATEGORIES,
  type PermissionCategory,
  SUBAGENT_NAMES,
} from "@oncue/protocol";
import type { WorkspaceApprovals } from "../approvals/store";
import { actionForCategory, decideAction } from "../policy/tiers";
import type { ApprovalCard } from "./approvals";

type RequestedPayload = PayloadOf<"approval.requested">;
type ToolKind = NonNullable<RequestedPayload["toolCategory"]>;

/**
 * Asks recorded per run, whether a card or a saved choice answered them. Each
 * is two durable events, so a run cannot fill the log. Past this a saved
 * choice still answers, unrecorded, so a long build under "Allow for this
 * session" keeps going; an ask that needs a card is refused.
 */
export const MAX_PERMISSION_ASKS_PER_RUN = 200;

/** The session's own choice: ask, or allow for this session. `always` lives in the workspace. */
export type SessionMode = "ask" | "session";

export function isPermissionCategory(value: string): value is PermissionCategory {
  return (PERMISSION_CATEGORIES as readonly string[]).includes(value);
}

export type PermissionRefusal =
  | "not_offered"
  | "malformed_resource"
  | "approval_open"
  | "run_not_running"
  | "too_many_requests";

/** The checks that need no row; run first so a malformed frame costs no read. */
export function judgePermissionClaim(
  claim: Pick<RequestedPayload, "category" | "resource">,
): PermissionRefusal | null {
  const action = actionForCategory(claim.category);
  if (
    !isPermissionCategory(claim.category) ||
    action === null ||
    decideAction(action, { approved: false }).kind !== "ask"
  ) {
    return "not_offered";
  }
  if (claim.resource.trim().length === 0) {
    return "malformed_resource";
  }
  if (claim.category === "start_subagent" && !SUBAGENT_RESOURCE.test(claim.resource)) {
    return "malformed_resource";
  }
  return null;
}

export interface PermissionContext {
  /** The frame names the session's current run, and that run is `running`. */
  readonly runRunning: boolean;
  readonly openApprovalExists: boolean;
}

/** Everything decidable from the run's rows before the decision. An open card first, so an honest repeat is not counted. */
export function judgePermissionAsk(context: PermissionContext): PermissionRefusal | null {
  if (context.openApprovalExists) {
    return "approval_open";
  }
  if (!context.runRunning) {
    return "run_not_running";
  }
  return null;
}

/**
 * How an ask past the decision is handled. Under the cap it is recorded;
 * past it a saved choice still answers without a record, and an ask that
 * needs a card is refused.
 */
export function pastTheCap(
  decision: PermissionDecision,
  askedThisRun: number,
): "record" | "answer_unrecorded" | "refuse" {
  if (askedThisRun < MAX_PERMISSION_ASKS_PER_RUN) {
    return "record";
  }
  return decision.kind === "allow" ? "answer_unrecorded" : "refuse";
}

/**
 * Refusals that close the bridge's socket once there are too many. A repeat
 * while a card is open is honest, and a run past its cap did nothing wrong:
 * a long build asks often. Every other refusal counts, as for secrets
 * (`isCountedRefusal`).
 */
export function isCountedPermissionRefusal(reason: PermissionRefusal): boolean {
  return reason !== "approval_open" && reason !== "too_many_requests";
}

/**
 * Whether a resource names a secret file, whatever category the sandbox
 * claimed: a path, or one of several, whose name ends `.env` or contains
 * `.env.`, other than `.env.example`, in any case.
 */
export function namesSecretFile(resource: string): boolean {
  return resource
    .split(/[\s,]+/)
    .some(
      (token) =>
        !/\.env\.example$/i.test(token) && (/\.env$/i.test(token) || /\.env\./i.test(token)),
    );
}

/**
 * A subagent start's resource as the bridge writes it: a built-in subagent's
 * name, then the description the agent gave it. Any other shape is refused.
 */
const SUBAGENT_RESOURCE = new RegExp(`^(${SUBAGENT_NAMES.join("|")}) subagent(: .+)?$`, "s");

/**
 * The category the object decides by: a secret file always asks, however the
 * sandbox labelled it. A subagent start's resource is the agent's own
 * description of the task, not a path, so a description that mentions `.env`
 * is still a start; the start's own shape is checked by `judgePermissionClaim`.
 */
export function decidedCategory(claimed: PermissionCategory, resource: string): PermissionCategory {
  if (claimed === "start_subagent") {
    return claimed;
  }
  return namesSecretFile(resource) ? "secret_file" : claimed;
}

export interface SessionApprovals {
  readonly mode: SessionMode;
  readonly rules: readonly PermissionCategory[];
}

export type PermissionDecision =
  | { readonly kind: "allow"; readonly scope: Exclude<ApprovalScope, "once"> }
  | { readonly kind: "ask" };

const ASK: PermissionDecision = { kind: "ask" };

/** Secret files ask in every mode, and their card offers only Allow once or Deny. */
export function alwaysAsks(category: PermissionCategory): boolean {
  return category === "secret_file";
}

/**
 * Whether the session's own rows already answer, so the workspace's need not
 * be read. A session rule or mode wins before D1 is asked.
 */
export function decideFromSession(
  category: PermissionCategory,
  session: SessionApprovals,
): PermissionDecision | null {
  if (alwaysAsks(category)) {
    return ASK;
  }
  if (session.mode === "session" || session.rules.includes(category)) {
    return { kind: "allow", scope: "session" };
  }
  return null;
}

/** The whole decision: the session first, then the workspace's default and saved rules. */
export function decidePermission(
  category: PermissionCategory,
  session: SessionApprovals,
  workspace: WorkspaceApprovals,
): PermissionDecision {
  const fromSession = decideFromSession(category, session);
  if (fromSession !== null) {
    return fromSession;
  }
  if (
    workspace.defaultMode === "always" ||
    workspace.rules.some((rule) => rule.category === category)
  ) {
    return { kind: "allow", scope: "always" };
  }
  return ASK;
}

/** The answers a card offers. A scope outside these is refused, whatever the browser sent. */
export function offeredScopes(category: PermissionCategory): readonly ApprovalScope[] {
  return alwaysAsks(category) ? ["once"] : ["once", "session", "always"];
}

/**
 * The menu's choice, as the session keeps it. "Always allow" is the
 * workspace's default, which the browser saves; the session goes back to
 * asking, so turning the default off later asks again. `clearsRules`: the
 * session's per-category "Allow for this session" answers go too.
 */
export function applyModeChoice(mode: ApprovalMode): {
  readonly session: SessionMode;
  readonly clearsRules: boolean;
} {
  switch (mode) {
    case "session":
      return { session: "session", clearsRules: false };
    case "always":
    case "ask":
      return { session: "ask", clearsRules: true };
  }
}

const VERB: Readonly<Record<ToolKind, string>> = {
  file_read: "Read",
  file_write: "Edit",
  search: "Search",
  shell: "Run a command on",
  git_local: "Use",
  git_remote: "Use",
  browser: "Open",
  web: "Fetch",
  verification: "Use",
  artifact: "Use",
  policy_propose: "Use",
  other: "Use",
};

/** The card's second line: which kind of ask this is. */
export const CATEGORY_LABEL: Readonly<Record<PermissionCategory, string>> = {
  outside_project: "Files outside the project",
  secret_file: "Secret files",
  repeated_action: "Repeated action",
  start_subagent: "Starting a subagent",
  other_request: "Other request",
};

const RISK: Readonly<Record<PermissionCategory, RequestedPayload["risk"]>> = {
  outside_project: "medium",
  secret_file: "high",
  repeated_action: "low",
  start_subagent: "low",
  other_request: "medium",
};

/** The one plain line the card shows. `resource` is the sandbox's, already bounded by the protocol. */
export function permissionTitle(
  category: PermissionCategory,
  resource: string,
  toolKind: ToolKind | null,
): string {
  switch (category) {
    case "outside_project":
      return `${VERB[toolKind ?? "other"]} ${resource}, outside the project`;
    case "secret_file":
      return `${toolKind === "file_write" ? "Edit" : "Read"} ${resource}, a secret file`;
    case "repeated_action":
      return `Repeat ${resource} a third time in a row`;
    case "start_subagent":
      return `Start the ${resource}`;
    case "other_request":
      return `Allow ${resource}`;
  }
}

const EXPLANATION: Readonly<Record<PermissionCategory, string>> = {
  outside_project: "The agent wants to use a path outside the repository's work tree.",
  secret_file:
    "The agent wants to read a file that usually holds secrets. Secret files always ask, whatever the approval mode.",
  repeated_action:
    "The agent made the same call with the same input twice in a row and wants to try again.",
  start_subagent:
    "The agent wants to hand part of the task to a subagent: a second conversation on the same model connection, billed to it, that reports back to the agent.",
  other_request: "The coding agent asked for a permission OnCue has no category for.",
};

/** What the user is shown, in the object's words, so a click approves only what the card said. */
/** "Explore subagent": who asked, when it was a subagent rather than the primary agent. */
export function subagentLabel(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} subagent`;
}

export function permissionCardFor(input: {
  readonly category: PermissionCategory;
  readonly resource: string;
  readonly toolKind: ToolKind | null;
  readonly now: string;
  readonly ttlMs: number;
  /** The running subagent whose call asked, by its built-in name; absent for the primary agent. */
  readonly subagent?: string | undefined;
}): ApprovalCard {
  const plain = permissionTitle(input.category, input.resource, input.toolKind);
  const title = input.subagent === undefined ? plain : `${subagentLabel(input.subagent)}: ${plain}`;
  return {
    // Within the protocol's short text whatever the resource's length.
    title: title.length > 256 ? `${title.slice(0, 255)}…` : title,
    intendedAction: EXPLANATION[input.category],
    category: input.category,
    risk: RISK[input.category],
    resource: input.resource,
    requestedScope: CATEGORY_LABEL[input.category],
    expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
  };
}
