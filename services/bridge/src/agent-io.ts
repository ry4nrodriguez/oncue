/**
 * The interpreter: owns every socket, process, timer, and clock, and no
 * decision. `offer` is synchronous and commits state before any effect runs;
 * effect results come back as new inputs through `offer`, so two events in
 * the same tick cannot interleave, and a rejected adapter promise is fed back
 * as a failure input rather than thrown.
 *
 * Built once per process, not per link: a reconnect must not restart the
 * runtime. Durable drafts are stamped into the outbox whether or not a link
 * is up. A durable event is never dropped before it was sent: the newest
 * `OUTBOX_RING` sent events are kept to answer the object's `replay_from`, and
 * past `OUTBOX_UNSENT_MAX_BYTES` of unsent ones the harness's event stream is
 * paused until a link drains them. Ephemeral drafts are dropped while no link
 * is up, before they take a sequence slot, so the object sees no gap.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, NO_RUNTIME, type PayloadOf, type ProtocolEvent, specOf } from "@oncue/protocol";
import {
  AGENT_UID,
  type AgentEffect,
  type AgentInput,
  type AgentSnapshot,
  CHECKPOINT_PATCH_CONTENT_TYPE,
  type CheckpointOutcome,
  type CloneOutcome,
  type CommitOutcome,
  type HealthOutcome,
  initialAgentState,
  type PushNotDone,
  runtimeOf,
  step,
  TOOL_OUTPUT_CONTENT_TYPE,
} from "./agent";
import { attachmentDirName, attachmentPrompt, placeAttachments } from "./attachments";
import {
  type ArtifactIo,
  describeCheckpoint,
  fetchArtifactIo,
  type PushSkipped,
  runCheckpoint,
  SNAPSHOT_TIMEOUT_MS,
  sha256Hex,
} from "./checkpoint";
import { DIFF_CONTENT_TYPE } from "./diff-report";
import { createDiffBuilder } from "./diffs";
import { buildAckFrame, type FrameIdentity, type RestoreBundle } from "./frames";
import {
  applyRestore,
  CLONE_TIMEOUT_MS,
  checkoutBase,
  checkoutCommit,
  clone,
  type CloneOutcome as GitCloneOutcome,
  type GitIo,
  nodeGitIo,
  type PushGrant,
  prepareCheckpointScratch,
  type SingleUse,
  singleUse,
  snapshot,
} from "./git";
import { AGENT_HOME, agentTmpDir, createOpenCodeClient } from "./opencode";
import { boundResource } from "./permissions";
import type { RuntimeClient, RuntimeId } from "./runtime";

/** How long a `git_commit` call may wait for its snapshot before the model is told it did not finish. */
const COMMIT_ANSWER_DEADLINE_MS = 60_000;

/**
 * `git_commit` calls waiting for their answer, by request id. A deadline
 * answers if nothing else does, so the runtime is never left holding a call; a
 * second answer for one id is dropped.
 */
export interface CommitAnswers {
  wait(requestId: string, deadlineMs?: number): Promise<ToolText>;
  answer(requestId: string, text: string, isError: boolean): void;
}

export function createCommitAnswers(): CommitAnswers {
  const waiting = new Map<string, (answer: ToolText) => void>();
  const answer = (requestId: string, text: string, isError: boolean): void => {
    const resolve = waiting.get(requestId);
    waiting.delete(requestId);
    resolve?.({ text, isError });
  };
  return {
    wait: (requestId, deadlineMs = COMMIT_ANSWER_DEADLINE_MS) =>
      new Promise<ToolText>((resolve) => {
        waiting.set(requestId, resolve);
        setTimeout(
          () => answer(requestId, "Not committed: the commit did not finish in time.", true),
          deadlineMs,
        ).unref?.();
      }),
    answer,
  };
}

import { createClaudeClient } from "./claude-client";
import { createCodexClient, nodeLineChannel } from "./codex-client";
import { createPiClient } from "./pi-client";
import {
  type BridgeConfig,
  type BridgeExit,
  type BridgeIo,
  type BridgeLink,
  bridgeConnectHeaders,
  bridgeConnectUrl,
  clockOf,
  createReconnectPolicy,
  type Draft,
  heardLink,
  isWorthRetrying,
  type LinkOutcome,
  type Outbound,
  type RuntimeIdentity,
  randomOf,
  runLink,
  type SequenceCursor,
  type SessionHandler,
  stampDraft,
  timedHandler,
} from "./protocol";
import { createSecretRedactor } from "./redaction";
import { type RelayServer, startRelayServer } from "./relay-server";
import {
  detect,
  detectInstall,
  PROJECT_FILE_PATH,
  type RepositoryFiles,
  readProjectYaml,
  resolve,
} from "./repo-config";
import { secretToolAnswer } from "./secrets";
import {
  connectSupervisor,
  type SupervisorClient,
  type SupervisorOutcome,
} from "./supervisor-client";
import {
  ATTACHMENTS_ROOT,
  BASE_TREE_ROOT,
  CHECK_OUTPUT_DIR,
  type CheckExit,
  type CheckPaths,
  checkOutputPath,
  SUPERVISOR_SOCKET,
} from "./supervisor-protocol";
import {
  callOnCueTool,
  startToolServer,
  type ToolHandlers,
  type ToolServer,
  type ToolText,
} from "./tool-server";
import { type CheckRunOutcome, LOG_CONTENT_TYPE, tailOf } from "./verify";

/** The adapters `perform` dispatches to. One object so a test hands in fakes for all of them at once. */
export interface AgentAdapters {
  readonly supervisor: SupervisorClient;
  /** The harness client for a session whose runtime has no entry in `runtimes`: OpenCode's (`runtime.ts`). */
  readonly runtime: RuntimeClient;
  /** Each other harness's client, by runtime id; the session's model grant says which one runs. */
  readonly runtimes?: Readonly<Partial<Record<RuntimeId, RuntimeClient>>>;
  readonly git: GitIo;
  /** A read-only view of the cloned tree, for command detection and `.oncue/project.yaml`. */
  readonly files: RepositoryFiles;
  readonly relay: Pick<RelayServer, "setToken" | "port">;
  /** The tool server's port. Its calls arrive through `offer`, like the relay's failures. */
  readonly tools: Pick<ToolServer, "port">;
  /** Where a `git_commit` call's answer goes once the snapshot ran or the reducer refused. */
  readonly commits: Pick<CommitAnswers, "answer">;
  /** The artifact PUT and the restore GET. */
  readonly artifacts: ArtifactIo;
}

export interface AgentHost {
  /** What `runLink` gets. */
  readonly handler: SessionHandler;
  /** What `runLink` reports on `runtime.connected`: `NO_RUNTIME` until health answered. */
  readonly identity: () => RuntimeIdentity;
  /** The one entry point besides the handler. Synchronous; performs effects after committing state. */
  offer(input: AgentInput): void;
  /** Re-sends every durable event from `runtimeSequence` on, out of the ring. The object asks for this on a sequence gap. */
  replayFrom(runtimeSequence: number): void;
  /** What the `close_link` effect calls. `runBridgeWith` installs the live link's closer and clears it after. */
  installLinkCloser(closer: (() => void) | null): void;
  /** For assertions and one diagnostic line. Never contains a credential, by construction of `AgentState`. */
  snapshot(): AgentSnapshot;
  /** SIGTERM the runtime, stop the event subscription, in that order. The relay and supervisor sockets are the composer's to close. */
  shutdown(): Promise<void>;
}

/**
 * Sent events kept to answer `replay_from`, durable and streamed alike: the
 * object admits only the next sequence, so an event lost on a link that died
 * half-open must be sent again, whatever its kind. Unsent events are never
 * evicted. Enough for minutes of streaming, longer than a half-open link
 * takes to detect.
 */
export const OUTBOX_RING = 4096;
/** The sent events kept, in bytes; the oldest go first past it or past `OUTBOX_RING`. */
export const OUTBOX_SENT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Unsent durable events past this many bytes pause reading the harness's
 * event stream, so a long disconnect during a busy run cannot grow the
 * bridge's memory without bound or cost timeline rows. It bounds the bridge,
 * not the harness: OpenCode is not known to slow down when its stream goes
 * unread, and may buffer the unread events itself.
 */
export const OUTBOX_UNSENT_MAX_BYTES = 32 * 1024 * 1024;
/** After SIGTERM on `runtime.shutdown`, how long before SIGKILL. */
export const RUNTIME_STOP_GRACE_MS = 5_000;
/** Between one ended `/event` stream and the next attempt while the runtime is up. */
export const SUBSCRIBE_RETRY_MS = 500;
/** Longer than the client's own request timeout, so it fires only when that did not. */
export const HEALTH_PROBE_WATCHDOG_MS = 8_000;
export const WORKSPACE_DIR = "/workspace";
/** Under the bridge's 0700 home on the image: the private index and objects a checkpoint writes. */
export const DEFAULT_CHECKPOINT_DIR = "/opt/oncue/checkpoint";
/** Where a restore bundle is written for `git apply`, inside the scratch dir, and removed after. */
export const RESTORE_PATCH_NAME = "restore.patch";

/**
 * Dev-host replacements for the image's hard-coded paths, so the same clone,
 * spawn, and checkpoint code runs locally. Every field defaults to the
 * sandbox value.
 */
export interface RuntimeOverrides {
  readonly workspaceDir?: string;
  readonly runtimePort?: number;
  readonly runtimeBinary?: string;
  /** Each other harness's dev install, by runtime id; the image's own paths otherwise. */
  readonly runtimeBinaries?: Readonly<Record<string, string>>;
  /** The dev host's Node and runtime host, for a harness under the host. */
  readonly runtimeHost?: { readonly node: string; readonly host: string };
  /** The dev host's build of OnCue's Pi extension (`dist/pi-extension.mjs`). */
  readonly runtimeExtension?: string;
  readonly runtimeHome?: string;
  /** Where the dev host's in-process supervisor writes development secrets; the image uses `SECRETS_DIR`. */
  readonly secretsDir?: string;
  readonly checkpointDir?: string;
  readonly checkOutputDir?: string;
  readonly baseTreeRoot?: string;
  /** Where attachments are placed; the image uses `ATTACHMENTS_ROOT`. */
  readonly attachmentsRoot?: string;
  /** A check's `PATH`. The dev host passes its own, since its package managers live elsewhere. */
  readonly checkPath?: string;
  /** `OUTBOX_UNSENT_MAX_BYTES` unless a test needs a smaller bound to reach it. */
  readonly outboxUnsentMaxBytes?: number;
  /** `OUTBOX_RING` unless a test needs a smaller ring to fill it. */
  readonly outboxRing?: number;
}

/** Past this a check's log is cut, and the marker says so. Record 03's per-artifact limit. */
export const MAX_LOG_BYTES = 25 * 1024 * 1024;
export const LOG_CUT_MARKER =
  "\n[OnCue cut this log at 25 MiB; the rest of the output was not kept]\n";
export const EMPTY_LOG_TEXT = "(the check produced no output)\n";
export const UNREADABLE_LOG_TEXT = "(OnCue could not read this check's output)\n";
/** Logs read back but not yet staged, kept for the few attempts verification can be waiting on. */
export const CHECK_LOGS_KEPT = 4;
export const SANDBOX_CHECK_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * What a check runs with: the agent's own allowlisted variables, the agent's
 * home and private temporary directory (`agentTmpDir`), and `CI`, so test
 * runners do not wait for a terminal that is not there.
 */
export function checkEnvironment(home: string, path: string): Record<string, string> {
  return {
    PATH: path,
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: agentTmpDir(home),
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_STATE_HOME: `${home}/.local/state`,
    XDG_CACHE_HOME: `${home}/.cache`,
    CI: "1",
  };
}

/**
 * The bytes a check's log uploads as: never empty (an artifact declares at
 * least one byte), and cut with a marker when the check wrote more than one
 * artifact may hold.
 */
export function composeLog(raw: Buffer | null, truncated: boolean): Buffer {
  if (raw === null) {
    return Buffer.from(UNREADABLE_LOG_TEXT, "utf8");
  }
  if (raw.byteLength === 0) {
    return Buffer.from(EMPTY_LOG_TEXT, "utf8");
  }
  const marker = Buffer.from(LOG_CUT_MARKER, "utf8");
  if (!truncated && raw.byteLength <= MAX_LOG_BYTES) {
    return raw;
  }
  return Buffer.concat([raw.subarray(0, MAX_LOG_BYTES - marker.byteLength), marker]);
}

/**
 * The bridge's view of the tree it just cloned. Read-only, and only for the
 * definition reader: the agent owns the tree once it is handed over.
 */
export function workspaceFiles(root: string): RepositoryFiles {
  return {
    readFile: (path) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(join(root, path)),
  };
}

/** What the clone was of, for the sentences a person reads when it could not land. */
export interface CloneContext {
  /** The branch cloned: the base branch before the first push, the task branch after. */
  readonly branch: string;
  /** True when `branch` is the session's own task branch. */
  readonly ownBranch: boolean;
}

/** The timeline's sentence when the commit a session must resume at is gone from GitHub (record 07). */
export function commitMissingText(expected: string, context: CloneContext): string {
  const short = expected.slice(0, 8);
  return context.ownBranch
    ? `The last commit this session pushed (${short}) is no longer on GitHub: the history of ${context.branch} was rewritten. Start a new session to continue from ${context.branch} as it is now.`
    : `The commit this session started from (${short}) is no longer on GitHub: the history of ${context.branch} was rewritten. Start a new session to continue from ${context.branch} as it is now.`;
}

/** The sentence for a clone that ran past its time bound, which a transient failure rarely does. */
export function cloneTimedOutText(context: CloneContext): string {
  return `Cloning ${context.branch} did not finish within ${CLONE_TIMEOUT_MS / 60_000} minutes, so this session could not start. The repository may be too large to clone in that time.`;
}

/** The sentence for a branch that is gone from GitHub. */
export function branchMissingText(context: CloneContext): string {
  return `The branch ${context.branch} is no longer on GitHub, so this session cannot resume. Restore the branch on GitHub (a closed pull request offers Restore branch) and send your message again.`;
}

/**
 * Whether the cloned workspace is usable and what the repository defines. A
 * commit gone from GitHub is a failure, since `baseSha` would otherwise name a
 * commit the tree is not at.
 */
export function settleClone(
  outcome: GitCloneOutcome,
  files: RepositoryFiles,
  context: CloneContext,
): CloneOutcome {
  switch (outcome.kind) {
    case "cloned": {
      const yaml = files.readFile(PROJECT_FILE_PATH);
      const file = yaml === null ? null : readProjectYaml(yaml);
      const project = resolve(
        detect(files),
        file !== null && file.kind === "ok" ? file.file : null,
      );
      return { kind: "cloned", headSha: outcome.headSha, project, install: detectInstall(files) };
    }
    case "clone_failed":
      if (outcome.reason === "branch_missing") {
        return { kind: "failed", category: "branch_missing", detail: branchMissingText(context) };
      }
      if (outcome.reason === "timed_out") {
        return { kind: "failed", category: "timed_out", detail: cloneTimedOutText(context) };
      }
      return {
        kind: "failed",
        category: outcome.reason === "authentication_failed" ? "auth" : outcome.reason,
        detail: `git clone failed: ${outcome.reason}`,
      };
    case "verify_failed":
      return { kind: "failed", category: "unknown", detail: outcome.detail };
    case "commit_missing":
      return {
        kind: "failed",
        category: "commit_missing",
        detail: commitMissingText(outcome.expected, context),
      };
    case "grant_spent":
      return { kind: "failed", category: "unknown", detail: "the git grant was already used" };
  }
}

/** The result the reducer hears: the patch bytes stay behind, only their size travels. */
export function settleCheckpoint(
  result: Awaited<ReturnType<typeof runCheckpoint>>,
): CheckpointOutcome {
  switch (result.kind) {
    case "failed":
      return { kind: "failed", detail: result.detail };
    case "unchanged":
      return { kind: "unchanged", headSha: result.headSha };
    case "pushed":
      return { kind: "pushed", headSha: result.headSha };
    case "committed_only":
      return {
        kind: "committed_only",
        headSha: result.headSha,
        push: pushNotDone(result.pushOutcome),
        secretPaths: result.pushOutcome.kind === "withheld" ? result.pushOutcome.paths : undefined,
      };
    case "bundled":
      return {
        kind: "bundled",
        headSha: result.headSha,
        byteSize: Buffer.byteLength(result.patch, "utf8"),
        push: pushNotDone(result.pushOutcome),
      };
  }
}

/** `checkpoint.ts`'s reason a push did not happen, as the one word the reducer reports. */
function pushNotDone(skipped: PushSkipped): PushNotDone {
  switch (skipped.kind) {
    case "no_grant":
    case "grant_spent":
      return skipped.kind;
    case "refused":
    case "push_failed":
    case "withheld":
      return skipped.reason;
  }
}

interface OutboxEntry {
  readonly event: ProtocolEvent;
  /** Every stamped event has one; kept as a plain number so the ring can be searched without a null check per entry. */
  readonly runtimeSequence: number;
  /** The event's serialized size, counted against `OUTBOX_UNSENT_MAX_BYTES` until it is sent. */
  readonly bytes: number;
  sent: boolean;
}

function describeOutcome(result: SupervisorOutcome<unknown>): string {
  switch (result.kind) {
    case "ok":
      return "ok";
    case "refused":
      return `refused: ${result.denial}`;
    case "failed":
      return `failed: ${result.detail}`;
    case "unreachable":
      return "supervisor unreachable";
  }
}

/** The testable core: the same host over injected adapters and a shared cursor. */
export function createAgentHost(
  config: BridgeConfig,
  rawIo: BridgeIo,
  cursor: SequenceCursor,
  adapters: AgentAdapters,
  overrides: RuntimeOverrides = {},
): AgentHost {
  const identity: FrameIdentity = {
    sessionId: config.identity.sessionId,
    generation: config.identity.generation,
  };
  /**
   * Record 08: the supplied secret values live only in this process's memory,
   * and everything that leaves through this host passes the redactor: events,
   * streamed chunks, log lines, and artifact bytes.
   */
  const redactor = createSecretRedactor(LIMITS.streamChunkChars);
  // Every other member is the caller's own, bound to it; only `log` is wrapped.
  const log = (line: string): void => rawIo.log(redactor.text(line));
  const io: BridgeIo = new Proxy(rawIo, {
    get(target, key) {
      if (key === "log") {
        return log;
      }
      const member = Reflect.get(target, key);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const workspaceDir = overrides.workspaceDir ?? WORKSPACE_DIR;
  const attachmentsRoot = overrides.attachmentsRoot ?? ATTACHMENTS_ROOT;
  const scratchDir = overrides.checkpointDir ?? DEFAULT_CHECKPOINT_DIR;
  const checkPaths: CheckPaths = {
    workspace: workspaceDir,
    baseTreeRoot: overrides.baseTreeRoot ?? BASE_TREE_ROOT,
    checkOutputDir: overrides.checkOutputDir ?? CHECK_OUTPUT_DIR,
  };
  const checkEnv = checkEnvironment(
    overrides.runtimeHome ?? AGENT_HOME,
    overrides.checkPath ?? SANDBOX_CHECK_PATH,
  );
  let state = initialAgentState(identity.sessionId, identity.generation);
  let outbound: Outbound | null = null;
  let linkCloser: (() => void) | null = null;
  const outbox: OutboxEntry[] = [];
  let unsentCount = 0;
  let unsentBytes = 0;
  let sentBytes = 0;
  const nowMs = clockOf(rawIo);
  /** When the current link was welcomed; null while there is none. */
  let linkUpAtMs: number | null = null;
  /** Sequences already replayed on the current link: a repeated ask gets nothing new. */
  let replayedOnLink = new Set<number>();
  const unsentLimit = overrides.outboxUnsentMaxBytes ?? OUTBOX_UNSENT_MAX_BYTES;
  const ringSize = overrides.outboxRing ?? OUTBOX_RING;
  /** The paused event stream's wake-ups, called once the unsent bytes fall back under the bound. */
  let roomWaiters: (() => void)[] = [];
  const subscriptions = new AbortController();
  let subscribing = false;
  let waiting = false;
  let stopped = false;
  /** The push token's only home, as the relay's holder is the model token's. Taken once by the checkpoint that names its grant. */
  let heldPush: { readonly grantId: string; readonly grant: SingleUse<PushGrant> } | null = null;
  /** A bundled checkpoint's patch, keyed by checkpointId, until `stage_upload` moves it under its artifact. */
  const patches = new Map<string, Buffer>();
  const answerCommit = (requestId: string, text: string, isError: boolean): void =>
    adapters.commits.answer(requestId, text, isError);
  /** Bytes declared as artifacts, keyed by artifactId, until an upload grant sends them. */
  const staged = new Map<
    string,
    { readonly bytes: Buffer; readonly sha256: string; readonly contentType: string }
  >();
  /** A finished check's log, keyed by checkRunId, until `stage_upload` moves it under its artifact. */
  const checkLogs = new Map<string, Buffer>();
  /** Snapshots and diffs, one at a time, holding a large patch until `stage_upload` moves it. */
  const diffs = createDiffBuilder(workspaceDir, scratchDir, adapters.git, (line) => io.log(line));

  function offer(input: AgentInput): void {
    const result = step(state, input, {
      nowMs: Date.now(),
      nowIso: io.now(),
      newId: io.newEventId,
      relayPort: adapters.relay.port,
      toolPort: adapters.tools.port,
      runtimePort: overrides.runtimePort,
      runtimeBinary: overrides.runtimeBinary,
      runtimeCwd: overrides.workspaceDir,
      runtimeHome: overrides.runtimeHome,
      runtimeSecretsDir: overrides.secretsDir,
      runtimeAttachmentsDir: overrides.attachmentsRoot,
      runtimeBinaries: overrides.runtimeBinaries,
      runtimeHost: overrides.runtimeHost,
      runtimeExtension: overrides.runtimeExtension,
    });
    state = result.state;
    for (const effect of result.effects) {
      void perform(effect);
    }
  }

  /** The session's harness client: the model grant named the runtime. */
  function runtimeClient(): RuntimeClient {
    return adapters.runtimes?.[runtimeOf(state).id] ?? adapters.runtime;
  }

  function runtimePort(): number | null {
    const runtime = state.runtime;
    return runtime.kind === "probing" || runtime.kind === "listening" || runtime.kind === "ready"
      ? runtime.port
      : null;
  }

  function send(entry: OutboxEntry): void {
    if (outbound === null) {
      return;
    }
    outbound.sendEvent(entry.event);
    if (!entry.sent) {
      entry.sent = true;
      unsentCount -= 1;
      unsentBytes -= entry.bytes;
      sentBytes += entry.bytes;
    }
  }

  /** Stamps nothing: keeps an already stamped event in order and sends it if a link is up. */
  function enqueue(event: ProtocolEvent): void {
    const entry: OutboxEntry = {
      event,
      runtimeSequence: event.runtimeSequence ?? cursor.next - 1,
      bytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
      sent: false,
    };
    outbox.push(entry);
    unsentCount += 1;
    unsentBytes += entry.bytes;
    send(entry);
    trimOutbox();
  }

  /**
   * Evicts the oldest sent entries past the ring's count or bytes. Entries are
   * sent in order, so the sent ones are a prefix and nothing unsent is ever
   * reached. Nothing is evicted while no link is up, or until the current
   * link has stayed up `stableLinkMs`: "sent" means only handed to the
   * socket, and frames the last link lost while half-open are what the object
   * asks for first, after a flush of the backlog that could otherwise push
   * them out of the ring.
   */
  function trimOutbox(): void {
    if (linkUpAtMs === null || nowMs() - linkUpAtMs < config.stableLinkMs) {
      return;
    }
    let sentCount = outbox.length - unsentCount;
    let cut = 0;
    while (
      (sentCount > ringSize || sentBytes > OUTBOX_SENT_MAX_BYTES) &&
      outbox[cut]?.sent === true
    ) {
      sentBytes -= outbox[cut]?.bytes ?? 0;
      sentCount -= 1;
      cut += 1;
    }
    if (cut > 0) {
      outbox.splice(0, cut);
    }
  }

  function wakeRoomWaiters(): void {
    if (unsentBytes >= unsentLimit && !stopped) {
      return;
    }
    const waiters = roomWaiters;
    roomWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  /** Resolves once the unsent events fit the bound; the event stream awaits it before each read. */
  function outboxRoom(): Promise<void> {
    if (unsentBytes < unsentLimit || stopped) {
      return Promise.resolve();
    }
    if (roomWaiters.length === 0) {
      io.log(
        `bridge paused the ${runtimeOf(state).id} event stream: ${unsentCount} events wait for the control plane`,
      );
    }
    return new Promise((resolve) => roomWaiters.push(resolve));
  }

  function subscribeLoop(port: number): Promise<void> {
    if (subscribing) {
      return Promise.resolve();
    }
    subscribing = true;
    return (async () => {
      while (!stopped && runtimePort() === port) {
        io.log(`${runtimeOf(state).id} event stream: subscribing on port ${port}`);
        let delivered = 0;
        await runtimeClient().subscribe(
          port,
          (event) => {
            delivered += 1;
            if (delivered === 1) {
              io.log(`${runtimeOf(state).id} event stream: first event ${event.kind}`);
            }
            offer({ kind: "runtime_event", event });
            if (event.kind === "server_connected") {
              void offerPendingQuestions(port);
            }
          },
          subscriptions.signal,
          io.log,
          outboxRoom,
        );
        io.log(`${runtimeOf(state).id} event stream: ended after ${delivered} events`);
        if (stopped || runtimePort() !== port) {
          break;
        }
        await io.sleep(SUBSCRIBE_RETRY_MS);
      }
      subscribing = false;
    })();
  }

  /**
   * A question asked while the event stream was down would otherwise never
   * reach the user, and its harness's call would wait forever; one already
   * waiting here is offered again and changes nothing.
   */
  async function offerPendingQuestions(port: number): Promise<void> {
    const pending = (await runtimeClient().pendingQuestions?.(port)) ?? [];
    for (const event of pending) {
      if (stopped || runtimePort() !== port) {
        return;
      }
      offer({ kind: "runtime_event", event });
    }
  }

  async function waitForExit(): Promise<void> {
    if (waiting) {
      return;
    }
    waiting = true;
    const exit = await adapters.supervisor.wait();
    waiting = false;
    offer(
      exit.kind === "ok"
        ? { kind: "runtime_exited", code: exit.value.code, signal: exit.value.signal }
        : { kind: "runtime_exited", code: null, signal: null },
    );
  }

  /**
   * A streamed chunk goes through the stream's holdback, which can yield none,
   * one, or several chunks; the message's durable end carries the whole text,
   * so anything still held is dropped there. Everything else is redacted whole.
   */
  function redactDraft(draft: Draft): Draft[] {
    if (draft.type === "message.delta") {
      const payload = draft.payload as PayloadOf<"message.delta">;
      const key = `${payload.messageId}:${payload.partIndex}`;
      return redactor
        .stream(key, payload.part.text)
        .map(
          (text) =>
            ({ ...draft, payload: { ...payload, part: { ...payload.part, text } } }) as Draft,
        );
    }
    if (draft.type === "message.completed") {
      redactor.endStreams(`${(draft.payload as PayloadOf<"message.completed">).messageId}:`);
    }
    const payload = redactor.deep(draft.payload);
    if (draft.type === "approval.requested") {
      // Cut only once redacted, so a value straddling the cut is still caught.
      const requested = payload as PayloadOf<"approval.requested">;
      return [
        {
          ...draft,
          payload: { ...requested, resource: boundResource(requested.resource) },
        } as Draft,
      ];
    }
    return [{ ...draft, payload } as Draft];
  }

  // One arm per effect kind; each calls one adapter and feeds back exactly one result input.
  async function perform(effect: AgentEffect): Promise<void> {
    switch (effect.kind) {
      case "emit": {
        // Redacted before it is stamped, so a chunk that is wholly held back
        // takes no sequence number and leaves no gap for the object to ask about.
        for (const draft of redactDraft(effect.draft)) {
          // A streamed draft with no link to carry it is dropped before it is
          // stamped: a slot nobody will ever receive is a gap the object
          // cannot get past.
          if (outbound === null && specOf(draft.type).durability === "ephemeral") {
            continue;
          }
          enqueue(stampDraft(config, cursor, io, draft));
        }
        return;
      }
      case "ack":
        outbound?.sendAck(buildAckFrame(identity, effect.ref, effect.outcome));
        return;
      case "set_model_token":
        adapters.relay.setToken(effect.token, effect.expiresAt, effect.brokerOrigin);
        return;
      case "clone": {
        const grantId = effect.grant.grantId;
        try {
          const context: CloneContext = {
            branch: effect.grant.branch,
            // The task branch once a push landed on it; the base branch before.
            ownBranch:
              effect.grant.taskBranch !== null && effect.grant.taskBranch === effect.grant.branch,
          };
          let outcome = await clone(
            singleUse({
              token: effect.grant.token,
              cloneUrl: effect.grant.repository.cloneUrl,
              branch: effect.grant.branch,
              // What the clone must land on: the base before any checkpoint,
              // the last pushed checkpoint after one.
              baseSha: effect.grant.headSha,
              ownBranch: context.ownBranch,
            }),
            workspaceDir,
            adapters.git,
          );
          let restored: string | null = null;
          if (outcome.kind === "cloned") {
            if (outcome.landing !== "at_tip") {
              io.log(
                `bridge: clone of ${context.branch} landed ${outcome.landing} at ${outcome.headSha.slice(0, 8)}`,
              );
            }
            if (effect.grant.restore !== null) {
              const result = await restore(effect.grant.restore, outcome.fallbackSha);
              restored = result.failure;
              if (result.movedTo !== null) {
                outcome = { ...outcome, headSha: result.movedTo, fallbackSha: null };
              }
            }
          }
          offer({
            kind: "clone_settled",
            grantId,
            result:
              restored === null
                ? settleClone(outcome, adapters.files, context)
                : { kind: "failed", category: "restore", detail: restored },
          });
        } catch (error) {
          offer({
            kind: "clone_settled",
            grantId,
            result: {
              kind: "failed",
              category: "unknown",
              detail: error instanceof Error ? error.message : "clone threw",
            },
          });
        }
        return;
      }
      case "chown_workspace": {
        const result = await adapters.supervisor.chownWorkspace(effect.uid);
        offer({ kind: "chown_settled", ok: result.kind === "ok", detail: describeOutcome(result) });
        return;
      }
      case "start_runtime": {
        const result = await adapters.supervisor.startAgent(effect.request);
        if (result.kind !== "ok") {
          offer({
            kind: "runtime_started",
            result: { kind: "failed", detail: describeOutcome(result) },
          });
          return;
        }
        offer({
          kind: "runtime_started",
          result: { kind: "started", pid: result.value.pid, port: effect.port },
        });
        void waitForExit();
        return;
      }
      case "probe_health": {
        await io.sleep(effect.afterMs);
        // A probe that never settles would end the chain silently even with the
        // fetch's own timeout, so the watchdog does not depend on the fetch aborting.
        const watchdog = io
          .sleep(HEALTH_PROBE_WATCHDOG_MS)
          .then((): HealthOutcome => ({ kind: "not_yet", detail: "probe watchdog" }));
        offer({
          kind: "health",
          result: await Promise.race([runtimeClient().health(effect.port), watchdog]),
        });
        return;
      }
      case "subscribe_events":
        void subscribeLoop(effect.port);
        return;
      case "prompt": {
        const turnBase = effect.turnBase === null ? null : await diffs.turnBase(effect.turnBase);
        const port = runtimePort();
        if (port === null) {
          offer({
            kind: "prompt_settled",
            runId: effect.runId,
            result: { kind: "refused", detail: "no runtime to prompt" },
            turnBase,
          });
          return;
        }
        const placed = await placeAttachments(effect.attachments, {
          root: attachmentsRoot,
          dirName: attachmentDirName(effect.messageId, randomUUID()),
          download: (request) => adapters.artifacts.download(request),
          makeDir: async (dir) => {
            await mkdir(attachmentsRoot, { recursive: true });
            await mkdir(dir, { mode: 0o700 });
          },
          writeNew: (path, bytes) => writeFile(path, bytes, { mode: 0o600, flag: "wx" }),
          handOver: async (dir) =>
            (await adapters.supervisor.prepareAttachments(dir, AGENT_UID)).kind === "ok",
          log: (line) => io.log(line),
        });
        const told = attachmentPrompt(placed, effect.imageInput);
        const result = await runtimeClient().prompt(port, {
          conversation: effect.conversation,
          title: `OnCue run ${effect.runId}`,
          text: `${effect.text}${told.note}`,
          model: effect.model,
          effort: effect.effort,
          files: told.files,
        });
        offer({ kind: "prompt_settled", runId: effect.runId, result, turnBase });
        return;
      }
      case "build_diffs": {
        const result =
          effect.purpose === "run_end"
            ? await diffs.runEnd(effect.refs, effect.turnBaseSha)
            : await diffs.midRun(effect.refs);
        offer({ kind: "diffs_built", runId: effect.runId, purpose: effect.purpose, result });
        return;
      }
      case "diff_rebuild_timer":
        await io.sleep(effect.afterMs);
        offer({ kind: "diff_rebuild_due" });
        return;
      case "abort": {
        const port = runtimePort();
        const ok = port === null ? false : await runtimeClient().abort(port, effect.conversation);
        offer({
          kind: "abort_settled",
          runId: effect.runId,
          conversation: effect.conversation,
          ok,
        });
        return;
      }
      case "signal_runtime": {
        const result = await adapters.supervisor.signal(effect.signal);
        if (result.kind !== "ok") {
          io.log(`bridge could not ${effect.signal} the runtime: ${describeOutcome(result)}`);
        }
        return;
      }
      case "hold_push_token": {
        const replaced = heldPush?.grant.take();
        heldPush = {
          grantId: effect.grantId,
          grant: singleUse({ token: effect.token, cloneUrl: effect.cloneUrl, ref: effect.ref }),
        };
        // A rotated-out grant's token has no checkpoint left to spend it, so
        // it is revoked now rather than left alive in memory.
        if (replaced !== undefined && replaced.kind === "taken") {
          await adapters.git.revoke(replaced.value.token);
        }
        return;
      }
      case "checkpoint": {
        const held =
          heldPush !== null && heldPush.grantId === effect.pushGrantId ? heldPush.grant : null;
        if (held !== null) {
          heldPush = null;
        }
        const settle = (result: CheckpointOutcome) =>
          offer({
            kind: "checkpoint_settled",
            checkpointId: effect.checkpointId,
            result,
            diff: null,
            commit: null,
          });
        if (!(await prepareCheckpointScratch(scratchDir))) {
          // The grant left `heldPush` above and no checkpoint will spend it,
          // so its token is revoked here rather than dropped alive.
          const taken = held?.take();
          if (taken !== undefined && taken.kind === "taken") {
            await adapters.git.revoke(taken.value.token);
          }
          settle({ kind: "failed", detail: "scratch_unavailable" });
          return;
        }
        try {
          const result = await runCheckpoint(
            {
              workTree: workspaceDir,
              scratchDir,
              durableHeadSha: effect.durableHeadSha,
              parentSha: effect.parentSha,
              sessionBranch: effect.sessionBranch,
              cloneBranch: effect.cloneBranch,
              reason: effect.reason,
              message: effect.message ?? undefined,
              pushGrant: held,
              // Only while there is something to look for.
              secretPathsIn: redactor.holdsValues()
                ? (patch) => redactor.secretPathsIn(patch)
                : undefined,
            },
            adapters.git,
          );
          io.log(`bridge: ${describeCheckpoint(result)}`);
          if (result.kind === "bundled") {
            patches.set(effect.checkpointId, Buffer.from(result.patch, "utf8"));
          }
          const diff =
            effect.sessionBaseSha === null || result.kind === "failed"
              ? null
              : await diffs.sessionAt(effect.sessionBaseSha, result.headSha);
          // Only a publish names its message, only a pushed one reports a
          // commit, and only when it made one: a head that is the agent's
          // own last commit was reported when the agent made it.
          const commit =
            effect.message !== null &&
            result.kind === "pushed" &&
            result.headSha !== effect.parentSha
              ? await diffs.commitAt(effect.parentSha, result.headSha)
              : null;
          offer({
            kind: "checkpoint_settled",
            checkpointId: effect.checkpointId,
            result: settleCheckpoint(result),
            diff,
            commit,
          });
        } catch (error) {
          // The class only: an error's message can hold a path the agent chose.
          io.log(`bridge: checkpoint threw ${error instanceof Error ? error.name : typeof error}`);
          settle({ kind: "failed", detail: "unknown" });
        }
        return;
      }
      case "stage_upload": {
        const source = effect.source;
        let bytes: Buffer | null;
        let contentType: string;
        switch (source.kind) {
          case "text":
            bytes = Buffer.from(source.text, "utf8");
            contentType = TOOL_OUTPUT_CONTENT_TYPE;
            break;
          case "checkpoint":
            bytes = patches.get(source.checkpointId) ?? null;
            patches.delete(source.checkpointId);
            contentType = CHECKPOINT_PATCH_CONTENT_TYPE;
            break;
          case "check_log":
            bytes = checkLogs.get(source.checkRunId) ?? null;
            checkLogs.delete(source.checkRunId);
            contentType = LOG_CONTENT_TYPE;
            break;
          case "diff":
            bytes = diffs.take(source.digest);
            contentType = DIFF_CONTENT_TYPE;
            break;
        }
        if (bytes === null) {
          io.log(`bridge: nothing to stage for artifact ${effect.artifactId}`);
          return;
        }
        // A patch is the exception: one with a hole in it would restore a
        // broken work tree. It was scanned whole before it was made a bundle
        // (`runCheckpoint`), and one holding a value never gets this far.
        const clean = source.kind === "checkpoint" ? bytes : redactor.bytes(bytes);
        staged.set(effect.artifactId, { bytes: clean, sha256: sha256Hex(clean), contentType });
        return;
      }
      case "upload_deadline": {
        await io.sleep(effect.afterMs);
        // A grant that arrived took the bytes out of `staged`; its PUT settles the upload.
        if (staged.delete(effect.artifactId)) {
          io.log(`bridge: no upload grant for artifact ${effect.artifactId}; recorded without it`);
          offer({ kind: "upload_settled", artifactId: effect.artifactId, ok: false });
        }
        return;
      }
      case "run_check": {
        const settle = (outcome: CheckRunOutcome) =>
          offer({
            kind: "check_settled",
            runId: effect.runId,
            checkRunId: effect.checkRunId,
            outcome,
          });
        const outputPath = checkOutputPath(effect.checkRunId, checkPaths);
        const result = await adapters.supervisor.runCheck({
          checkRunId: effect.checkRunId,
          command: effect.command,
          cwd:
            effect.where.kind === "workspace"
              ? workspaceDir
              : join(checkPaths.baseTreeRoot, effect.where.dir),
          env: checkEnv,
          uid: AGENT_UID,
          timeoutMs: effect.timeoutMs,
          outputPath,
        });
        if (result.kind !== "ok") {
          settle({ kind: "could_not_run", detail: describeOutcome(result) });
          return;
        }
        // A base run only decides a comparison; its output is not a record of its own.
        const log =
          effect.where.kind === "base" ? null : await readCheckLog(outputPath, result.value);
        if (log !== null) {
          checkLogs.set(effect.checkRunId, log);
          for (const stale of [...checkLogs.keys()].slice(0, -CHECK_LOGS_KEPT)) {
            checkLogs.delete(stale);
          }
        }
        settle({
          kind: "exited",
          exitCode: result.value.exitCode,
          signal: result.value.signal,
          timedOut: result.value.timedOut,
          durationMs: result.value.durationMs,
          logBytes: log?.byteLength ?? 0,
          tail: log === null ? "" : tailOf(log.toString("utf8")),
        });
        return;
      }
      case "signal_check": {
        const first = await adapters.supervisor.signalCheck(effect.checkRunId, "SIGTERM");
        if (first.kind !== "ok") {
          return;
        }
        await io.sleep(effect.escalateAfterMs);
        const second = await adapters.supervisor.signalCheck(effect.checkRunId, "SIGKILL");
        if (
          second.kind !== "ok" &&
          !(second.kind === "refused" && second.denial === "no_such_check")
        ) {
          io.log(`bridge could not stop check ${effect.checkRunId}: ${describeOutcome(second)}`);
        }
        return;
      }
      case "prepare_base": {
        const ok = await prepareBase(effect.dir, effect.baseSha);
        offer({ kind: "base_prepared", runId: effect.runId, dir: effect.dir, ok });
        return;
      }
      case "upload": {
        const entry = staged.get(effect.artifactId) ?? null;
        staged.delete(effect.artifactId);
        const settle = (ok: boolean) =>
          offer({ kind: "upload_settled", artifactId: effect.artifactId, ok });
        if (entry === null || entry.bytes.byteLength > effect.maxBytes) {
          settle(false);
          return;
        }
        const result = await adapters.artifacts.upload({
          url: effect.url,
          token: effect.token,
          bytes: entry.bytes,
          contentType: entry.contentType,
          sha256: entry.sha256,
        });
        settle(result.ok);
        return;
      }
      case "close_link":
        linkCloser?.();
        return;
      case "log":
        io.log(`bridge: ${effect.line}`);
        return;
      case "write_secrets": {
        // The one place a value is handled. Each goes to the supervisor, which
        // writes it where only the agent reads, and into this process's
        // redaction set; it is written, logged, and echoed nowhere here.
        const failedNames: string[] = [];
        for (const secret of effect.secrets) {
          redactor.add(secret.value);
          const result = await adapters.supervisor.writeSecret(secret.name, secret.value);
          if (result.kind !== "ok") {
            failedNames.push(secret.name);
            // The outcome names a denial or an operating-system error, never the value.
            io.log(`bridge could not supply ${secret.name}: ${describeOutcome(result)}`);
          }
        }
        offer({ kind: "secrets_written", grantId: effect.grantId, failedNames });
        return;
      }
      case "reply_permission": {
        const port = runtimePort();
        const ok =
          port !== null &&
          (await runtimeClient().replyHeld(port, effect.requestId, effect.reply, effect.message));
        if (!ok) {
          // The request was already gone, or OpenCode was. Either way nothing
          // was released: a value reaches the agent only through a grant.
          io.log(`bridge could not answer a held tool call (${effect.reply})`);
        }
        return;
      }
      case "reply_question": {
        const port = runtimePort();
        const ok =
          port !== null &&
          (await runtimeClient().replyQuestion(port, effect.requestId, effect.reply));
        if (!ok) {
          // The harness had already dropped the question (an aborted turn does),
          // or the harness was gone.
          io.log(`bridge could not ${effect.reply.kind} a waiting question`);
        }
        return;
      }
      case "approval_timer":
        await io.sleep(Math.max(0, effect.atMs - Date.now()));
        offer({ kind: "approval_deadline", ref: effect.ref });
        return;
      case "clear_secrets": {
        const result = await adapters.supervisor.clearSecrets();
        if (result.kind !== "ok") {
          io.log(`bridge could not clear the secrets: ${describeOutcome(result)}`);
        }
        return;
      }
      case "commit_answer":
        answerCommit(effect.requestId, effect.text, effect.isError);
        return;
      case "commit_work": {
        // A snapshot parented on the chain's tip, in the bridge's own git dir.
        // The model is answered first, and the reducer hears it afterwards.
        const settle = (result: CommitOutcome) =>
          offer({ kind: "commit_settled", requestId: effect.requestId, result });
        if (!(await prepareCheckpointScratch(scratchDir))) {
          answerCommit(
            effect.requestId,
            "Not committed: the bridge's scratch space is unavailable.",
            true,
          );
          settle({ kind: "failed", detail: "scratch_unavailable" });
          return;
        }
        try {
          const snapped = await snapshot(
            workspaceDir,
            scratchDir,
            effect.parentSha,
            effect.message,
            adapters.git,
            { timeoutMs: SNAPSHOT_TIMEOUT_MS },
          );
          if (snapped.kind === "failed") {
            answerCommit(effect.requestId, `Not committed (${snapped.detail}).`, true);
            settle({ kind: "failed", detail: snapped.detail });
            return;
          }
          if (snapped.kind === "unchanged") {
            answerCommit(
              effect.requestId,
              `Nothing to commit: the tree is unchanged since ${snapped.sha.slice(0, 8)}.`,
              false,
            );
            settle({ kind: "unchanged", sha: snapped.sha });
            return;
          }
          const commit = await diffs.commitAt(effect.parentSha, snapped.sha);
          const counted =
            commit === null
              ? ""
              : ` (${commit.files.length} ${commit.files.length === 1 ? "file" : "files"}, +${commit.additions} -${commit.deletions})`;
          answerCommit(
            effect.requestId,
            `Committed ${snapped.sha.slice(0, 8)}${counted}. It is pushed when the session's Git policy allows a push; do not push yourself.`,
            false,
          );
          settle({ kind: "committed", sha: snapped.sha, parentSha: effect.parentSha, commit });
        } catch (error) {
          io.log(`bridge: git_commit threw ${error instanceof Error ? error.name : typeof error}`);
          answerCommit(effect.requestId, "Not committed: the commit failed.", true);
          settle({ kind: "failed", detail: "unknown" });
        }
        return;
      }
      default: {
        // Every effect is performed or this does not compile: an effect the
        // reducer asks for and nobody performs is a silent hang.
        const unperformed: never = effect;
        return unperformed;
      }
    }
  }

  async function readCheckLog(path: string, exit: CheckExit): Promise<Buffer> {
    try {
      return composeLog(await readFile(path), exit.truncated);
    } catch {
      return composeLog(null, false);
    }
  }

  /** Check the base revision out as the bridge, then hand it to the agent user. False on any failure. */
  async function prepareBase(dirName: string, baseSha: string): Promise<boolean> {
    const dir = join(checkPaths.baseTreeRoot, dirName);
    if (!(await prepareCheckpointScratch(scratchDir))) {
      return false;
    }
    try {
      await mkdir(checkPaths.baseTreeRoot, { recursive: true });
      await mkdir(dir);
    } catch {
      io.log(`bridge: could not make the base checkout ${dirName}`);
      return false;
    }
    const checkedOut = await checkoutBase(workspaceDir, scratchDir, dir, baseSha, adapters.git);
    if (checkedOut.kind === "failed") {
      io.log(`bridge: base checkout failed: ${checkedOut.detail}`);
      return false;
    }
    const handed = await adapters.supervisor.prepareBase(dir, AGENT_UID);
    if (handed.kind !== "ok") {
      io.log(`bridge: could not hand the base checkout over: ${describeOutcome(handed)}`);
      return false;
    }
    return true;
  }

  /**
   * Applies the grant's bundle to the fresh clone and commits it, while the
   * bridge still owns the tree (before `chown_workspace`). `fallbackSha` is the
   * session's own last push when someone pushed a newer tip: if the patch does
   * not apply there, the tree moves back to the fallback and applies it, so no
   * saved edit is lost and GitHub refuses the next push as a non-fast-forward
   * rather than overwriting anything. `movedTo` then names the new commit.
   */
  async function restore(
    bundle: RestoreBundle,
    fallbackSha: string | null,
  ): Promise<{ readonly failure: string | null; readonly movedTo: string | null }> {
    const failed = (failure: string) => ({ failure, movedTo: null });
    if (!(await prepareCheckpointScratch(scratchDir))) {
      return failed("scratch_unavailable");
    }
    const downloaded = await adapters.artifacts.download({ url: bundle.url, token: bundle.token });
    if (downloaded.kind === "failed") {
      return failed(`download_failed (${downloaded.status ?? "no answer"})`);
    }
    const patchPath = join(scratchDir, RESTORE_PATCH_NAME);
    try {
      await writeFile(patchPath, downloaded.bytes, { mode: 0o600 });
    } catch {
      return failed("patch_unwritable");
    }
    try {
      const applied = await applyRestore(workspaceDir, patchPath, adapters.git);
      if (applied.kind === "restored") {
        io.log(`bridge: restored checkpoint bundle ${bundle.artifactId} as ${applied.headSha}`);
        return { failure: null, movedTo: null };
      }
      if (applied.detail !== "apply_failed" || fallbackSha === null) {
        return failed(applied.detail);
      }
      // `git apply --index` changes nothing when it fails, so the tree is
      // still the clone's and can move.
      if (!(await checkoutCommit(workspaceDir, fallbackSha, adapters.git))) {
        return failed("apply_failed");
      }
      const again = await applyRestore(workspaceDir, patchPath, adapters.git);
      if (again.kind === "failed") {
        return failed(again.detail);
      }
      io.log(
        `bridge: restored checkpoint bundle ${bundle.artifactId} on the session's own push ${fallbackSha.slice(0, 8)}, behind the branch's newer tip`,
      );
      return { failure: null, movedTo: fallbackSha };
    } finally {
      await unlink(patchPath).catch(() => {});
    }
  }

  const handler: SessionHandler = {
    onWelcome(next, connected) {
      outbound = next;
      linkUpAtMs = nowMs();
      replayedOnLink = new Set();
      for (const entry of outbox) {
        if (!entry.sent) {
          send(entry);
        }
      }
      // After everything stamped before it, and kept, so a replay that
      // reaches back past it can send it again.
      enqueue(connected());
    },
    onLinkUp(next) {
      outbound = next;
      linkUpAtMs ??= nowMs();
      for (const entry of outbox) {
        if (!entry.sent) {
          send(entry);
        }
      }
      trimOutbox();
      wakeRoomWaiters();
      offer({ kind: "connected" });
    },
    onLinkDown() {
      outbound = null;
      linkUpAtMs = null;
      offer({ kind: "disconnected" });
    },
    onFrame(frame) {
      offer({ kind: "frame", frame });
    },
  };

  return {
    handler,
    identity: () =>
      state.runtime.kind === "ready"
        ? { runtimeName: runtimeOf(state).id, runtimeVersion: state.runtime.version }
        : { runtimeName: NO_RUNTIME, runtimeVersion: NO_RUNTIME },
    offer,
    replayFrom(runtimeSequence) {
      if (replayedOnLink.has(runtimeSequence)) {
        // Sent once on this link already; sending the same frames again would
        // only make the object read and refuse each one again.
        return;
      }
      const oldest = outbox[0];
      if (oldest !== undefined && oldest.runtimeSequence > runtimeSequence) {
        io.log(
          `bridge cannot replay from ${runtimeSequence}: the ring starts at ${oldest.runtimeSequence}`,
        );
        // Sending from the gap would make the object refuse and ask again, an
        // unbounded exchange that exhausts Durable Object reads
        // (`docs/architecture/01-control-plane.md`, "Read cost"). The object
        // closes the socket instead, and the reconnect settles the cursor.
        return;
      }
      replayedOnLink.add(runtimeSequence);
      for (const entry of outbox) {
        if (entry.runtimeSequence >= runtimeSequence) {
          send(entry);
        }
      }
    },
    installLinkCloser(closer) {
      linkCloser = closer;
    },
    snapshot: () => state,
    async shutdown() {
      stopped = true;
      wakeRoomWaiters();
      subscriptions.abort();
      if (runtimePort() !== null || state.runtime.kind === "starting") {
        await adapters.supervisor.signal("SIGTERM");
      }
    },
  };
}

/**
 * A link whose incoming `replay_from` frames are also handed to the host, and
 * whose `close` fires its own close listener so `runLink` settles without
 * waiting for the socket's close event.
 */
function observedLink(link: BridgeLink, host: AgentHost): BridgeLink {
  let closeListener: ((code?: number) => void) | null = null;
  return {
    send: (text) => link.send(text),
    close: () => {
      link.close();
      closeListener?.();
    },
    terminate: () => {
      if (link.terminate === undefined) {
        link.close();
      } else {
        link.terminate();
      }
      closeListener?.();
    },
    ...(link.ping === undefined ? {} : { ping: () => link.ping?.() }),
    ...(link.onPong === undefined
      ? {}
      : { onPong: (listener: () => void) => link.onPong?.(listener) }),
    onMessage(listener) {
      link.onMessage((data) => {
        try {
          const parsed: unknown = JSON.parse(data);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as Record<string, unknown>).type === "replay_from" &&
            typeof (parsed as Record<string, unknown>).runtimeSequence === "number"
          ) {
            host.replayFrom((parsed as Record<string, unknown>).runtimeSequence as number);
          }
        } catch {
          // Not JSON: `classifyIncoming` reports it.
        }
        listener(data);
      });
    },
    onClose(listener) {
      closeListener = listener;
      link.onClose(listener);
    },
  };
}

/**
 * `protocol.ts`'s `runBridge`, with the host's handler and identity passed to
 * every `runLink` and a `close_link` effect ending the loop as `shutdown`.
 * The reconnect policy is the same one `runBridge` uses.
 */
export async function runBridgeWith(
  config: BridgeConfig,
  io: BridgeIo,
  host: AgentHost,
  cursor: SequenceCursor,
): Promise<BridgeExit> {
  const url = bridgeConnectUrl(config);
  const headers = bridgeConnectHeaders(config);
  const nowMs = clockOf(io);
  const policy = createReconnectPolicy(config, nowMs(), randomOf(io));
  const timed = timedHandler(host.handler, nowMs);
  let shutdownRequested = false;

  io.log(
    `bridge ${config.bridgeVersion} starting for sandbox generation ${config.identity.generation}`,
  );
  for (;;) {
    io.log(`bridge connecting to the control plane, attempt ${policy.attempts + 1}`);
    timed.reset();
    let lastHeardAtMs: () => number | null = () => null;
    let outcome: LinkOutcome;
    try {
      const heard = heardLink(observedLink(await io.connect(url, headers), host), nowMs);
      lastHeardAtMs = heard.lastHeardAtMs;
      const link = heard.link;
      host.installLinkCloser(() => {
        shutdownRequested = true;
        link.close();
      });
      outcome = await runLink(config, io, link, cursor, timed.handler, host.identity);
    } catch {
      // Never the message: a failed WebSocket connect error can carry the
      // request headers, and one of those is the bootstrap credential.
      io.log("bridge could not reach the control plane");
      outcome = { kind: "disconnected" };
    }
    host.installLinkCloser(null);
    if (outcome.kind === "shutdown" || shutdownRequested) {
      return { kind: "shutdown" };
    }
    if (outcome.kind === "refused" && !isWorthRetrying(outcome.reason)) {
      return { kind: "refused", reason: outcome.reason };
    }
    const delay = policy.next({
      linkedUpAtMs: timed.linkedUpAtMs(),
      lastHeardAtMs: lastHeardAtMs(),
      endedAtMs: nowMs(),
    });
    if (delay === null) {
      return { kind: "exhausted", attempts: policy.attempts };
    }
    await io.sleep(delay);
  }
}

export interface ComposedBridge {
  readonly host: AgentHost;
  /** Connect, negotiate, reconnect, stop: `runBridgeWith` over this host. */
  run(): Promise<BridgeExit>;
  /** After `run` settles: the runtime, the relay, and the supervisor socket, in that order. */
  shutdown(): Promise<void>;
}

/**
 * Composition for `main.ts`: connects the supervisor, starts the relay, builds
 * the runtime clients, then `createAgentHost`. The dev host swaps in its
 * in-process supervisor and path `overrides`.
 */
export async function agentIo(
  config: BridgeConfig,
  io: BridgeIo,
  overrides: RuntimeOverrides = {},
  connectSupervisorImpl: () => Promise<SupervisorClient> = () =>
    connectSupervisor(SUPERVISOR_SOCKET),
): Promise<ComposedBridge> {
  const supervisor = await connectSupervisorImpl();
  const cursor: SequenceCursor = { next: 0 };
  let host: AgentHost | null = null;
  const commits = createCommitAnswers();
  const relay = await startRelayServer({
    sessionId: config.identity.sessionId,
    fetchImpl: fetch,
    onFailure: (failure) => host?.offer({ kind: "model_failure", failure }),
    onPromptCounts: (reading) => host?.offer({ kind: "prompt_counts", reading }),
    log: io.log,
  });
  const toolHandlers: ToolHandlers = {
    onPropose: (call) => host?.offer({ kind: "policy_tool_called", call }),
    onDescribe: (call) => host?.offer({ kind: "describe_tool_called", call }),
    onCommit: (call) => {
      const requestId = io.newEventId();
      const answer = commits.wait(requestId);
      if (host === null) {
        commits.answer(requestId, "Not committed: the bridge is not ready.", true);
      } else {
        host.offer({ kind: "commit_tool_called", requestId, call });
      }
      return answer;
    },
    // From the reducer's record of what the supervisor wrote, never from the
    // fact that the call arrived: the gate in front of this tool is cooperative.
    secretAnswer: (name) =>
      host === null
        ? { text: "That secret has not been supplied to this session.", isError: true }
        : secretToolAnswer(host.snapshot().secrets, name, (secret) =>
            supervisor.secretPath(secret),
          ),
  };
  const tools = await startToolServer(toolHandlers);
  host = createAgentHost(
    config,
    io,
    cursor,
    {
      supervisor,
      runtime: createOpenCodeClient(fetch),
      runtimes: {
        codex: createCodexClient({
          connect: nodeLineChannel,
          callTool: (name, args) => callOnCueTool(name, args, toolHandlers),
          cwd: overrides.workspaceDir ?? WORKSPACE_DIR,
        }),
        // Pi's tools reach the tool server above through OnCue's extension.
        pi: createPiClient({ connect: nodeLineChannel, readFile: (path) => readFile(path) }),
        // Claude Code reaches the tool server above over MCP, as OpenCode does.
        claude: createClaudeClient({
          connect: nodeLineChannel,
          readFile: (path) => readFile(path),
        }),
      },
      git: nodeGitIo(),
      files: workspaceFiles(overrides.workspaceDir ?? WORKSPACE_DIR),
      relay,
      tools,
      commits,
      artifacts: fetchArtifactIo(fetch),
    },
    overrides,
  );
  const built = host;
  return {
    host: built,
    run: () => runBridgeWith(config, io, built, cursor),
    async shutdown() {
      await built.shutdown();
      await relay.close();
      await tools.close();
      supervisor.close();
    },
  };
}
