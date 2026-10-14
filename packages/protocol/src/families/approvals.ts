import { defineFamily } from "../define";
import {
  agentId,
  approvalId,
  boolean,
  boundedList,
  commandId,
  counter,
  exactOptional,
  nullable,
  picklist,
  sha,
  shortText,
  strictObject,
  summaryText,
  timestamp,
  toolCallId,
  userId,
} from "../schema";
import { toolCategory } from "./tools";

/**
 * The harness's own permission asks, in OnCue's words (record 09, "Agent
 * permissions"). Each harness's asks are mapped onto these by its adapter, so
 * the control plane decides them without reading a harness's shapes.
 */
export const PERMISSION_CATEGORIES = [
  "outside_project",
  "secret_file",
  "repeated_action",
  "start_subagent",
  "other_request",
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

// Record 09, Tier 3.
export const approvalCategory = picklist([
  "development_secret",
  "external_connection",
  "network_expansion",
  "external_action",
  "other",
  ...PERMISSION_CATEGORIES,
]);

/**
 * How the agent's permission asks are answered (record 09). `ask` shows a card
 * each time, `session` allows for this session, and `always` allows in every
 * session of the workspace. Secret files ask in every mode.
 */
export const APPROVAL_MODES = ["ask", "session", "always"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const approvalMode = picklist(APPROVAL_MODES);

/** What one answer covers: this request, this session, or every session. */
export const APPROVAL_SCOPES = ["once", "session", "always"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];
export const approvalScope = picklist(APPROVAL_SCOPES);

// Record 04: plain language, affected resource, risk, scope, expiration.
// Record 08: names only. There is no field for a secret value or raw command
// content, by construction.
const secretName = shortText;

export const APPROVAL_EVENTS = defineFamily("approvals", {
  "approval.requested": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      approvalId,
      title: shortText,
      intendedAction: summaryText,
      category: approvalCategory,
      risk: picklist(["low", "medium", "high"]),
      resource: shortText,
      requestedScope: summaryText,
      expiresAt: timestamp,
      toolCallId: nullable(toolCallId),
      // The kind of tool behind a permission ask, for the card's verb. Absent
      // on secrets and wherever the bridge has not seen the call.
      toolCategory: exactOptional(toolCategory),
      // The subagent whose call asked (record 12); absent for the primary
      // agent's asks, for secrets, and on every older event.
      agentId: exactOptional(agentId),
    }),
  },
  // Control-origin: record 04 forbids the sandbox approving its own actions.
  "approval.resolved": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      approvalId,
      decision: picklist(["approved", "rejected"]),
      decidedBy: userId,
      commandId,
      // The generation the decision was made against; a replaced sandbox must
      // revalidate it before use.
      decidedForGeneration: counter,
      // What the answer covers; absent on older events and on secrets, which
      // are always one request.
      scope: exactOptional(approvalScope),
      // True when a saved choice answered, not a click on this card.
      automatic: exactOptional(boolean()),
    }),
  },
  "approval.expired": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      approvalId,
      effect: picklist(["run_paused", "run_failed", "tool_denied"]),
    }),
  },
  // The user's choice in the composer's approval menu. `always` also set the
  // workspace's default; any other choice cleared it.
  "approval.mode_changed": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      mode: approvalMode,
      decidedBy: userId,
      commandId,
    }),
  },
  // What the user confirmed on the disclosure card before launch, as the
  // control plane re-derived it from the project file at `baseSha`.
  // `supplied` are the names the session starts with, `withheld` the optional
  // names left unticked (the agent may still ask), and `missing` the required
  // names with nothing saved that the user chose to start without.
  "secrets.disclosed": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      baseSha: sha,
      supplied: boundedList(secretName),
      withheld: boundedList(secretName),
      missing: boundedList(secretName),
      /** The file was refused by the reader and the user started anyway: nothing supplied, and the session cannot end verified. */
      invalid: boolean(),
    }),
  },
  // Approved and supplied are different facts; this is the second. The bridge
  // answered the grant carrying these names, so `delivered` true means the
  // supervisor wrote every file. `approvalId` is null for a launch selection.
  "secrets.supplied": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      names: boundedList(secretName),
      approvalId: nullable(approvalId),
      delivered: boolean(),
    }),
  },
});
