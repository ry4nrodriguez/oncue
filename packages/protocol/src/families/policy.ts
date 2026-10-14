import { COMMAND_TYPES } from "../commands";
import { defineFamily } from "../define";
import {
  artifactRef,
  bodyText,
  boundedList,
  commandId,
  counter,
  exactOptional,
  messageId,
  nullable,
  picklist,
  proposalId,
  runId,
  shortText,
  strictObject,
  summaryText,
  timestamp,
  userId,
} from "../schema";

// Small enough to carry before and after in one event, which record 04
// requires. Dimensions come from record 07's chat controls and record 12's
// plan-approval instructions.
export const sessionPolicy = strictObject({
  version: counter,
  commit: picklist(["auto", "manual"]),
  push: picklist(["auto", "manual", "never"]),
  pullRequest: picklist(["auto_after_verification", "manual", "never"]),
  planApproval: picklist(["proceed", "wait_for_user"]),
  fileEdits: picklist(["allowed", "blocked"]),
});

export const policyDirection = picklist(["narrowing", "widening", "mixed"]);

export const commandType = picklist(COMMAND_TYPES);

export const POLICY_EVENTS = defineFamily("policy", {
  "policy.proposed": {
    scope: "session",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      proposalId,
      triggeringMessageId: nullable(messageId),
      from: sessionPolicy,
      to: sessionPolicy,
      direction: policyDirection,
      rationale: summaryText,
    }),
  },
  // Record 07: restrictive proposals apply at once; permissive ones wait for
  // one-click confirmation; product controls write the policy directly.
  "policy.updated": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      proposalId: nullable(proposalId),
      from: sessionPolicy,
      to: sessionPolicy,
      confirmedBy: picklist([
        "user_confirmation",
        "immediate_narrowing",
        "product_control",
        "system",
      ]),
      userId: nullable(userId),
      effectiveAt: timestamp,
    }),
  },
  // The user's Decline on the confirmation card. The policy does not change;
  // the event closes every client's card and logs who declined what.
  "policy.declined": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      proposalId,
      userId,
      declinedAt: timestamp,
    }),
  },
  "command.acknowledged": {
    scope: "session",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      commandId,
      commandType,
      acceptedBy: picklist(["control_plane", "bridge"]),
    }),
  },
  "command.rejected": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      commandId,
      commandType,
      reason: picklist([
        "wrong_state",
        "stale_generation",
        "unknown_approval",
        "not_owner",
        "admission_closed",
        "duplicate",
        "unsupported",
      ]),
      expectedState: nullable(shortText),
      actualState: nullable(shortText),
      detail: summaryText,
    }),
  },
  // Record 10's two delivery choices for a message sent during a run.
  "message.queued": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      messageId,
      commandId,
      text: bodyText,
      delivery: picklist(["steer_current_run", "run_next"]),
      deliveredToRunId: nullable(runId),
      // The follow-up's attachments, as the control plane recorded them.
      // Absent when there are none.
      attachments: exactOptional(boundedList(artifactRef)),
    }),
  },
  "sandbox.keepalive.updated": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      expiresAt: nullable(timestamp),
      requestedBy: picklist(["user", "preview_activity", "system"]),
      minutes: counter,
    }),
  },
});
