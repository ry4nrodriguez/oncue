// The session object's bounds, intervals, and fixed names.

import type { SandboxState } from "@oncue/protocol";
import type { StopCause } from "../lifecycle";

export const SHUTDOWN_REASON: Record<StopCause, "idle" | "replaced" | "cancelled"> = {
  idle: "idle",
  lifetime_ceiling: "replaced",
  user_requested: "cancelled",
};

export const LIVE_OR_STARTING_STATUS: ReadonlySet<SandboxState> = new Set([
  "requested",
  "provisioning",
  "ready",
  "attached",
  "active",
  "idle",
  "checkpointing",
]);

/**
 * Record 02's "Prepare": the controller holds each `prepareImage` call at most
 * this long for a build under way, then answers `building`.
 */
export const PREPARE_WAIT_MS = 20_000;

/**
 * The most polls one provisioning makes for its image, whatever the clock
 * says: the default budget over the default spacing.
 */
export const MAX_PREPARE_POLLS = 144;

/**
 * How many `prepareImage` polls in a row may fail retryably before the
 * provisioning fails. An unanswered poll takes the driver's whole deadline, so
 * five of them is about two minutes, where the image budget would have polled
 * a dead controller for twelve.
 */
export const MAX_PREPARE_FAILURES = 5;

/** How long a refused late stop waits before the alarm tries it again. */
export const LATE_STOP_RETRY_MS = 60_000;
/** Tries before a late stop is given up and the sandbox named as possibly running. */
export const LATE_STOP_MAX_ATTEMPTS = 5;
/** Late stops one alarm wake runs, so a wake stays bounded. */
export const LATE_STOPS_PER_ALARM = 4;
/** Failed generations an erase stops by name once more, newest first; bounds its provider calls. */
export const FINAL_STOP_GENERATIONS = 3;

/** How a provisioning paces its provider calls; a field on the object so a test can shorten it. */
export interface ProvisionPacing {
  /**
   * How long a provisioning waits for its image. A workspace that has never
   * built the current image builds it now, for minutes. Under the 15 minutes
   * a pending outbound request keeps a Durable Object in memory.
   */
  readonly prepareBudgetMs: number;
  /** Polls at least this far apart, so a controller answering at once cannot spin the loop. */
  readonly minPreparePollMs: number;
  /** The pause before each further create after a retryable failure; its length bounds the attempts. */
  readonly createRetryDelaysMs: readonly number[];
  /**
   * When a failed generation's sandbox is stopped. More than once, because a
   * create whose answer was lost can land after the first stop found nothing.
   */
  readonly failedStopDelaysMs: readonly number[];
  /**
   * How long after a create is sent the controller may still start its
   * sandbox (`notAfter`). Shorter than the driver's 60-second create deadline,
   * so the controller gives up before the Worker does.
   */
  readonly createNotAfterMs: number;
  /**
   * How long after `notAfter` a create already under way may still land. The
   * stop sweep's last stop, and a recovery's verdict, wait for it.
   */
  readonly createLandingGraceMs: number;
}

export const PROVISION_PACING: ProvisionPacing = {
  prepareBudgetMs: 12 * 60_000,
  minPreparePollMs: 5_000,
  createRetryDelaysMs: [2_000, 5_000],
  failedStopDelaysMs: [0, 15_000, 45_000],
  createNotAfterMs: 40_000,
  createLandingGraceMs: 30_000,
};

export const OUTPUT_POLL_INTERVAL_MS = 2_000;
export const OUTPUT_POLL_BUDGET_MS = 120_000;
/**
 * Polls made after the bridge has connected. Modal surfaces a sandbox's output
 * seconds after it is printed, so stopping at `runtime.connected` would miss
 * what the bridge printed on its way up. The controller holds the cursor on an
 * empty poll, so late lines still land inside this window.
 */
export const OUTPUT_DRAIN_POLLS = 8;

/** The header carrying the presented bootstrap credential. Only this object holds its hash, so only it can compare. */
export const BRIDGE_CREDENTIAL_HEADER = "x-oncue-bridge-credential";

/**
 * How many times one bridge socket may be asked to replay a missing frame
 * before the object closes it. A bridge whose ring no longer holds the frame
 * can never answer, and asking without bound once exhausted the account's
 * Durable Object reads (record 01). The reconnect re-reads the cursor.
 */
export const MAX_REPLAY_ASKS = 3;

/**
 * How many refused `run.verified` claims one bridge socket may make before it
 * is closed. The real bridge never claims what its records do not support, so
 * a socket that keeps claiming is forging or broken and is bounded here.
 */
export const MAX_OUTCOME_REFUSALS = 3;

/**
 * How many refused `policy.proposed` frames one bridge socket may send. The
 * sandbox is untrusted and each refusal still costs reads, so the object bounds
 * it. The fourth closes the socket.
 */
export const MAX_PROPOSAL_REFUSALS = 3;

/**
 * The same bound for `approval.requested`, per socket. The generation also
 * counts (`approval_refusal_count`): past `MAX_SESSION_APPROVAL_REFUSALS`, each
 * further counted refusal closes the socket at once, so a reconnect does not
 * reset the budget. A new generation starts at zero.
 */
export const MAX_APPROVAL_REFUSALS = 3;
export const MAX_SESSION_APPROVAL_REFUSALS = 12;

/**
 * The same bound for `question.asked`, per socket. An honest race with an
 * open question is not counted.
 */
export const MAX_QUESTION_REFUSALS = 3;

/** A git grant's advisory `expiresAt`: GitHub's installation-token lifetime. */
export const GIT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
/**
 * The grant envelope requires an expiry, but a development secret really ends
 * with its sandbox: the supervisor removes it at shutdown. A day outlives any
 * generation.
 */
export const SECRET_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a sent secret grant may go unacknowledged before it is settled as not delivered. */
export const SECRET_GRANT_ACK_MS = 2 * 60 * 1000;
/** Withheld-checkpoint reports a generation may store: the one unrequested push report, bounded. */
export const MAX_SECRET_WITHHOLDINGS = 3;
export const SHUTDOWN_POLL_MS = 50;
