import { defineFamily } from "../define";
import {
  artifactRef,
  boolean,
  boundedList,
  checkpointId,
  counter,
  nullable,
  picklist,
  sha,
  shortText,
  strictObject,
  summaryText,
  timestamp,
} from "../schema";

export const sandboxProvider = picklist(["modal", "fake"]);

// The envelope's sandboxGeneration is the generation each event describes;
// `sandbox.replaced` also names the one it replaced.
export const SANDBOX_EVENTS = defineFamily("sandbox", {
  "sandbox.provisioning": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      provider: sandboxProvider,
      reason: picklist(["initial", "resume", "replacement", "retry"]),
      attempt: counter,
      // Record 11's cache layers: which one this start reuses.
      cacheReuse: picklist(["base_image", "repository_environment", "none"]),
    }),
  },
  "sandbox.attached": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      provider: sandboxProvider,
      providerSandboxId: shortText,
      startupMs: counter,
      // Modal's 24-hour ceiling, so the interface can show the planned replacement.
      expiresAt: timestamp,
      cacheFallback: boolean(),
    }),
  },
  "sandbox.idle": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      idleSince: timestamp,
      stopAt: timestamp,
      keepAliveUntil: nullable(timestamp),
    }),
  },
  "sandbox.checkpointed": {
    scope: "session",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      checkpointId,
      kind: picklist(["branch_push", "local_commit", "patch_bundle"]),
      headSha: nullable(sha),
      bundle: nullable(artifactRef),
      reason: picklist(["idle", "user", "lifetime_ceiling", "policy_change", "cancel", "pause"]),
      durationMs: counter,
    }),
  },
  // A checkpoint the bridge could not take at all, because Git could not
  // stage or commit the work tree. Nothing was saved, pushed, or bundled. A
  // fixed category, never git's own text, which could contain an agent-chosen
  // path.
  "sandbox.checkpoint_failed": {
    scope: "session",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      checkpointId,
      reason: picklist(["idle", "user", "lifetime_ceiling", "policy_change", "cancel", "pause"]),
      failure: picklist([
        "read_tree_failed",
        "add_failed",
        "write_tree_failed",
        "parent_unreadable",
        "commit_failed",
        "timed_out",
        // The bridge's own scratch directory could not be made ready.
        "scratch_unavailable",
        // Anything else that went wrong; its text stays in the sandbox.
        "unknown",
      ]),
      durationMs: counter,
    }),
  },
  // What the sandbox itself printed (image build lines, entrypoint output,
  // provider system lines), relayed by the control plane before the bridge
  // can report. Untrusted: shown verbatim, never used to derive a label or
  // state. `controller` lines are the control plane's notes on its own
  // provider calls, in the same stream.
  "sandbox.output": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      stream: picklist(["stdout", "stderr", "system", "controller"]),
      lines: boundedList(strictObject({ at: timestamp, text: summaryText })),
    }),
  },
  // `outcome` discriminates record 11's `stopped` and `failed` states.
  "sandbox.stopped": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      outcome: picklist(["stopped", "failed"]),
      reason: picklist([
        "idle",
        "keepalive_expired",
        "lifetime_ceiling",
        "user_requested",
        "policy",
        "provisioning_failed",
        "failure",
        "disappeared",
        "emergency_termination",
      ]),
      checkpointId: nullable(checkpointId),
      unsavedWorkWarning: nullable(summaryText),
      diagnostics: boundedList(artifactRef),
    }),
  },
  "sandbox.replaced": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      previousGeneration: counter,
      reason: picklist(["resume", "lifetime_ceiling", "policy_change", "failure"]),
      restoredFrom: nullable(checkpointId),
      explanation: summaryText,
    }),
  },
  // Record 11: the object took back every credential it handed this
  // generation before marking the attachment stopped. `not_held` is a grant
  // this generation never received.
  "sandbox.credentials_revoked": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      reason: picklist(["idle", "lifetime_ceiling", "user_requested", "disappeared"]),
      grants: boundedList(
        strictObject({
          kind: picklist(["model", "git", "push", "upload"]),
          outcome: picklist(["revoked", "not_held", "failed"]),
        }),
      ),
    }),
  },
});
