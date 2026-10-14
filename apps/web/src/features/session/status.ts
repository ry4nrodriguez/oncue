import type { DisplayStatus, ModelFailureCategory } from "@oncue/protocol";
import type { ConnectionState } from "./transport";

/** Status labels (record 13); a superset of run outcomes, so a session with no run has one too. */
export const STATUS_LABELS: Record<DisplayStatus, string> = {
  idle: "Idle",
  starting_environment: "Starting environment",
  working: "Working",
  waiting_for_approval: "Waiting for approval",
  waiting_for_input: "Waiting for you",
  paused: "Paused",
  resuming: "Resuming",
  verified: "Verified",
  completed_with_warnings: "Completed with warnings",
  // The run changed no files, so no checks ran (record 14).
  completed: "Done",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  caught_up: "Caught up",
  offline: "Offline",
};

/**
 * Plain words for a `model_failure` pause (record 15). A total `Record`, so a
 * new category is a compile error rather than a fallback to the wire spelling.
 */
export const MODEL_FAILURE_WORDS: Record<ModelFailureCategory, string> = {
  temporary_service_failure: "the provider had a temporary problem",
  rate_limited: "the provider is rate-limiting this key",
  usage_limit_reached: "this key has reached its usage limit",
  authentication_failed: "the provider rejected the model key",
  model_unavailable: "the model is unavailable right now",
  request_rejected: "the provider rejected the request",
  broker_failure: "OnCue's model broker failed",
};
