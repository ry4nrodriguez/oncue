/**
 * The session Durable Object (record 01). Every decision is a pure function in
 * this directory (`ingest.ts`, `commands.ts`, `replay.ts`, `outbox.ts`,
 * `dispatch.ts`); the modules under `object/` turn decisions into SQL, socket
 * sends, and alarms. This file keeps the per-instance state, `fetch()`, the
 * socket and alarm hooks, and one-line delegators into those modules.
 *
 * Both WebSocket upgrades are accepted in `fetch()` before anything reaches
 * `super.fetch()`: accepting a socket inside an Agents SDK hook loses the tags
 * dispatch relies on. The class never calls `setState()` or defines
 * `initialState`, so no SDK state-sync frame reaches either socket, and the
 * alarm uses `ctx.storage.setAlarm` rather than the SDK's `schedule()`. No
 * `cf_agents_*` table is read or written here.
 *
 * The Worker verifies the caller and forwards the identity in
 * `x-oncue-user-id`, the only identity header this object trusts. It still
 * refuses a client socket whose header disagrees with
 * `session.owner_user_id`, and stamps every command with the socket's stored
 * user id rather than anything on the wire.
 */

import type { AttachedBridge, BridgeScriptName } from "@oncue/bridge";
import type { SessionState } from "@oncue/protocol";
import { Agent } from "agents";
import type { GitHubAppDeps } from "../github/app";
import type { BridgeSocketSink } from "../sandbox/fake-driver";
import {
  admitApproval,
  sendApprovalFrame,
  sweepApprovals,
  tellBridgeOfApproval,
} from "./object/approval-gate";
import {
  authorizeArtifact,
  authorizeAttachmentFetch,
  authorizeUpload,
  completeArtifact,
  failArtifact,
  mintArtifactToken,
  readArtifact,
  revokeArtifactTokens,
} from "./object/artifact-uploads";
import {
  dispatch,
  expireGrants,
  failRun,
  leavePending,
  readDispatchState,
  revokeTokens,
  runFailedEvent,
} from "./object/bridge-dispatch";
import { handleBridgeFrame, reactToCommittedFrame } from "./object/bridge-intake";
import {
  closeAttachedBridges,
  currentBridge,
  handleBridgeUpgrade,
  openBridgeSocket,
  webSocketClose,
} from "./object/bridge-sockets";
import { handleClientFrame, handleClientUpgrade } from "./object/client-sockets";
import {
  broadcastToClients,
  commitControlEvents,
  decideAdmissionNow,
  drainOutboxNow,
  enqueueOutboxSnapshot,
  planAndCommit,
} from "./object/commit";
import { judgeVerified, refuseVerified } from "./object/completion-gate";
import {
  BRIDGE_CREDENTIAL_HEADER,
  PROVISION_PACING,
  type ProvisionPacing,
} from "./object/constants";
import type { HostArgs, SessionHost } from "./object/host";
import {
  admitCommit,
  admitDescription,
  admitProposal,
  commitPolicyUpdate,
  refuseProposal,
  sendPolicyToBridge,
} from "./object/policy";
import {
  commitOutputLines,
  createSession,
  failProvisioning,
  provisionSandbox,
  recoverProvisioning,
  runLateStops,
  scheduleLateStop,
  stopFailedGenerations,
} from "./object/provisioning";
import {
  finishPublish,
  issueCheckpoint,
  markPushGrantsSpent,
  maybePublish,
} from "./object/publish";
import {
  lockDownAfterForeignPush,
  maybeOpenPullRequest,
  recordPullRequestState,
} from "./object/pull-request";
import {
  admitQuestion,
  deliverQuestionDecision,
  resendQuestionDecision,
  sweepQuestions,
} from "./object/question-gate";
import { composeContext, provisionReplacement, resumeFor, resumeIfOwed } from "./object/resume";
import {
  driverForGeneration,
  extendKeepAlive,
  lifecycleView,
  moveAttachment,
  openCredential,
  rearm,
  runLifecycle,
} from "./object/sandbox-lifecycle";
import {
  advanceStop,
  applyStopPlan,
  revokeGenerationCredentials,
  signalStop,
  stopGeneration,
  stopSandbox,
} from "./object/sandbox-stop";
import {
  computeSecretGrantDeadlineMs,
  ensureRedactor,
  isSecretWithholding,
  pinDeclaration,
  readSecretGrantDeadlineMs,
  recordSecretsSettled,
  requestApprovedSecret,
  requestLaunchSecrets,
  sendSecretGrant,
  settleUnansweredSecretGrants,
} from "./object/session-secrets";
import {
  archiveSession,
  deleteSession,
  deletionMarked,
  eraseSession,
  sessionExists,
  unarchiveSession,
} from "./object/session-state";
import { readRepositoryBase } from "./object/store-git";
import { nameTaskBranch } from "./object/task-branch";
import type {
  ArchiveSessionBody,
  ArtifactAuthorizeBody,
  ArtifactCompleteBody,
  ArtifactFailBody,
  CreateSessionBody,
  DeleteSessionBody,
  PullRequestStateBody,
  SessionRow,
  StopSandboxBody,
} from "./object/types";
import { extractBridgeGeneration } from "./object/wire";
import SCHEMA_SQL from "./schema.sql?raw";

export type { ProvisionPacing } from "./object/constants";
export {
  BRIDGE_CREDENTIAL_HEADER,
  MAX_APPROVAL_REFUSALS,
  MAX_OUTCOME_REFUSALS,
  MAX_PROPOSAL_REFUSALS,
  MAX_QUESTION_REFUSALS,
  MAX_REPLAY_ASKS,
  MAX_SESSION_APPROVAL_REFUSALS,
  OUTPUT_DRAIN_POLLS,
  OUTPUT_POLL_BUDGET_MS,
  OUTPUT_POLL_INTERVAL_MS,
  PROVISION_PACING,
} from "./object/constants";
export type {
  ArchiveSessionBody,
  ArchiveSessionResult,
  ArtifactAuthorizeBody,
  ArtifactAuthorizeResult,
  ArtifactCompleteBody,
  ArtifactCompleteResult,
  ArtifactFailBody,
  ArtifactIndexRow,
  ArtifactReadResult,
  CreateSessionBody,
  CreateSessionRepository,
  CreateSessionResult,
  CreateSessionSecretsRecord,
  DeleteSessionBody,
  DeleteSessionResult,
  EraseSessionResult,
  KeepAliveResult,
  PullRequestStateBody,
  SessionRow,
  StopSandboxBody,
  StopSandboxResult,
  UnarchiveSessionResult,
} from "./object/types";
export { grantModel } from "./object/wire";

export class SessionObject extends Agent<Env> implements BridgeSocketSink, SessionHost {
  pendingScriptName: BridgeScriptName = "seven-event";
  pendingTaskBranch: string | null = null;
  pendingBaseCommitSha: string | null = null;
  pendingFramePacingMs: number | null = null;
  pendingRedactionSecrets: readonly string[] = [];
  provisionPacing: ProvisionPacing = PROVISION_PACING;
  /**
   * The generation this object's memory is provisioning (`provisionSandbox`,
   * from the first image poll to attach or failure, and `recoverProvisioning`),
   * or null. In memory on purpose: after a restart it is null, which is how the
   * alarm tells a lost provisioning from a running one.
   */
  provisioningInFlight: number | null = null;
  /** The generation `ensureRedactor` last rebuilt for. In memory like the values, so an eviction clears both. */
  redactorGeneration: number | null = null;
  /** True while one `approval.requested` is judged across its D1 reads; a second frame meanwhile is refused as `approval_open`. */
  approvalJudging = false;
  /**
   * The earliest ack deadline among outstanding secret grants. In memory because
   * the rearm path must not read the dispatch table per frame; loaded once per
   * wake and recomputed on an ack or settle, which are rare.
   */
  secretGrantDeadlineMs: number | null = null;
  secretGrantDeadlineLoaded = false;
  readonly attachedBridges = new Map<
    number,
    { readonly attached: AttachedBridge; readonly client: WebSocket }
  >();
  /**
   * GitHub tokens sent to the bridge and not yet revoked, by grant id, with the
   * deps that minted them and their job (clone read or push write). In memory
   * only: the bridge's own revoke and GitHub's one-hour expiry are the backstops
   * after hibernation. Never written to SQLite.
   */
  readonly volatileGitTokens = new Map<
    string,
    { readonly token: string; readonly deps: GitHubAppDeps; readonly kind: "git" | "push" }
  >();
  /**
   * Push grants the bridge reported a checkpoint for. The bridge revokes those
   * tokens itself, so GitHub's 401 on our revoke means already dead, not failed.
   */
  readonly bridgeSpentPushGrants = new Set<string>();
  /**
   * Consecutive replays asked of one socket with no frame admitted since. Weak
   * so a closed socket needs no cleanup; in memory because it bounds one socket.
   */
  readonly replayAsks = new WeakMap<WebSocket, number>();
  /** Refused `run.verified` claims per bridge socket, weak and in memory for the same reasons. */
  readonly outcomeRefusals = new WeakMap<WebSocket, number>();
  readonly proposalRefusals = new WeakMap<WebSocket, number>();
  readonly approvalRefusals = new WeakMap<WebSocket, number>();
  readonly questionRefusals = new WeakMap<WebSocket, number>();
  /** When the alarm should revoke a clone token still in the map; null when none is owed. */
  gitGrantDeadlineMs: number | null = null;
  /** The same for a checkpoint push token. */
  pushGrantDeadlineMs: number | null = null;
  /** When the outbox drain next retries a projection D1 refused; null when nothing is pending. */
  outboxDueAtMs: number | null = null;
  /** A resume that has not yet committed its new generation; a second resume joins it. */
  resuming: Promise<void> | null = null;
  /**
   * How many provisionings, and the stop sweeps that follow a failed or
   * abandoned one, are under way in this object's memory. An erase waits for
   * them, since a sandbox they make or have yet to stop would have no object
   * left to stop it. Distinct from `provisioningInFlight`, the generation the
   * alarm uses to tell a lost provisioning from one under way.
   */
  provisioningsPending = 0;
  /**
   * How many calls are carrying a stop forward in this object's memory. One
   * goes on after the generation is marked ended (the sandbox's last output
   * is fetched and committed), so an erase waits for them rather than have
   * that land in the emptied object.
   */
  stopsAdvancing = 0;
  /**
   * True once this instance has erased its session. In memory on purpose:
   * the only callers still holding the erased session's row are awaits that
   * were in flight in this same memory, and a restart leaves none.
   */
  erased = false;
  /** The generation `resuming` is replacing, or null for an ordinary resume or none. */
  replacing: number | null = null;

  branchNaming: Promise<string | null> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA_SQL);
      this.reconcileBridgeGeneration();
    });
  }

  /** The object's state, for its modules; `ctx` itself is protected. */
  get objectCtx(): DurableObjectState {
    return this.ctx;
  }

  /** The bindings, read live: tests replace `env` on the instance. */
  get objectEnv(): Env {
    return this.env;
  }

  readSession(): SessionRow | null {
    const rows = [
      ...this.ctx.storage.sql.exec<{
        id: string;
        workspace_id: string;
        owner_user_id: string;
        state: string;
        title: string | null;
        current_run_id: string | null;
        sandbox_generation: number;
        last_runtime_sequence: number | null;
      }>(
        "SELECT id, workspace_id, owner_user_id, state, title, current_run_id, sandbox_generation, last_runtime_sequence FROM session LIMIT 1",
      ),
    ];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ownerUserId: row.owner_user_id,
      state: row.state as SessionState,
      title: row.title,
      currentRunId: row.current_run_id,
      sandboxGeneration: row.sandbox_generation,
      lastRuntimeSequence: row.last_runtime_sequence,
    };
  }

  // fetch() owns both WebSocket upgrades before delegating to the SDK. The fake
  // bridge's socket opens in-process and never arrives here;
  // `handleBridgeUpgrade` checks the credential `routes/ws-bridge.ts` forwards,
  // because only this object holds its hash.
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/internal/create") && request.method === "POST") {
      const body = (await request.json()) as CreateSessionBody;
      const result = await this.createSession(body);
      return Response.json(result);
    }
    if (url.pathname.endsWith("/internal/stop") && request.method === "POST") {
      const body = (await request.json()) as StopSandboxBody;
      return Response.json(await this.stopSandbox(body));
    }
    if (url.pathname.endsWith("/internal/archive") && request.method === "POST") {
      return Response.json(await this.archiveSession((await request.json()) as ArchiveSessionBody));
    }
    if (url.pathname.endsWith("/internal/unarchive") && request.method === "POST") {
      return Response.json(this.unarchiveSession());
    }
    if (url.pathname.endsWith("/internal/delete") && request.method === "POST") {
      return Response.json(await this.deleteSession((await request.json()) as DeleteSessionBody));
    }
    if (url.pathname.endsWith("/internal/deletion/marked") && request.method === "POST") {
      return Response.json(this.deletionMarked());
    }
    if (url.pathname.endsWith("/internal/deletion/erase") && request.method === "POST") {
      return Response.json(await this.eraseSession());
    }
    if (url.pathname.endsWith("/internal/exists") && request.method === "POST") {
      return Response.json(this.sessionExists());
    }
    if (url.pathname.endsWith("/internal/pull-request-state") && request.method === "POST") {
      return Response.json(
        this.recordPullRequestState((await request.json()) as PullRequestStateBody),
      );
    }
    if (url.pathname.endsWith("/internal/incident") && request.method === "POST") {
      return Response.json(await this.lockDownAfterForeignPush());
    }
    if (url.pathname.endsWith("/internal/keep-alive") && request.method === "POST") {
      return Response.json(await this.extendKeepAlive());
    }
    if (url.pathname.endsWith("/internal/artifacts/authorize") && request.method === "POST") {
      return Response.json(
        await this.authorizeArtifact((await request.json()) as ArtifactAuthorizeBody),
      );
    }
    if (url.pathname.endsWith("/internal/artifacts/complete") && request.method === "POST") {
      return Response.json(this.completeArtifact((await request.json()) as ArtifactCompleteBody));
    }
    if (url.pathname.endsWith("/internal/artifacts/fail") && request.method === "POST") {
      return Response.json(this.failArtifact((await request.json()) as ArtifactFailBody));
    }
    if (url.pathname.endsWith("/internal/attachments/authorize") && request.method === "POST") {
      const body = (await request.json()) as {
        readonly attachmentId: string;
        readonly token: string;
      };
      return Response.json(await this.authorizeAttachmentFetch(body.attachmentId, body.token));
    }
    if (url.pathname.endsWith("/internal/artifacts/read") && request.method === "POST") {
      const body = (await request.json()) as { readonly artifactId: string };
      return Response.json(this.readArtifact(body.artifactId));
    }
    if (url.pathname.endsWith("/client") && request.headers.get("Upgrade") === "websocket") {
      return this.handleClientUpgrade(url, request.headers.get("x-oncue-user-id"));
    }
    const bridgeGeneration = extractBridgeGeneration(url.pathname);
    if (bridgeGeneration !== null && request.headers.get("Upgrade") === "websocket") {
      return this.handleBridgeUpgrade(
        bridgeGeneration,
        request.headers.get(BRIDGE_CREDENTIAL_HEADER),
        url.origin,
      );
    }
    return super.fetch(request);
  }

  // Every socket is tagged "client" or "bridge" when it is accepted, since every
  // upgrade is intercepted in `fetch()`, so dispatch on the tag is total.
  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const raw = typeof message === "string" ? message : "";
    const tags = this.ctx.getTags(ws);
    if (tags.includes("bridge")) {
      await this.handleBridgeFrame(ws, raw);
      return;
    }
    await this.handleClientFrame(ws, raw);
  }

  override async webSocketError(): Promise<void> {
    return undefined;
  }

  // Driven by `ctx.storage.setAlarm`, never the SDK's `schedule()`. Each owner
  // of the alarm re-derives what is due from its own facts, so an early fire
  // costs the others nothing, and `rearm` sets the earliest.
  override async alarm(): Promise<void> {
    await this.drainOutboxNow();
    await this.expireGrants();
    this.sweepApprovals();
    // Before the lifecycle, which reads whether a question still waits.
    this.sweepQuestions();
    await this.runLifecycle();
    await this.runLateStops();
    await this.rearm();
  }

  // On wake, close any bridge socket whose generation is not the current one;
  // record 01 requires a transport-level close.
  private reconcileBridgeGeneration(): void {
    const session = this.readSession();
    if (session === null) {
      return;
    }
    for (const ws of this.ctx.getWebSockets("bridge")) {
      const tags = this.ctx.getTags(ws);
      const genTag = tags.find((tag) => tag.startsWith("gen:"));
      if (genTag === undefined || genTag !== `gen:${session.sandboxGeneration}`) {
        ws.close(4001, "stale generation on wake");
      }
    }
  }

  // store-git.ts
  readRepositoryBase(): ReturnType<typeof readRepositoryBase> {
    return readRepositoryBase(this.ctx.storage.sql);
  }

  // commit.ts
  enqueueOutboxSnapshot(
    ...args: HostArgs<typeof enqueueOutboxSnapshot>
  ): ReturnType<typeof enqueueOutboxSnapshot> {
    return enqueueOutboxSnapshot(this, ...args);
  }

  planAndCommit(...args: HostArgs<typeof planAndCommit>): ReturnType<typeof planAndCommit> {
    return planAndCommit(this, ...args);
  }

  commitControlEvents(
    ...args: HostArgs<typeof commitControlEvents>
  ): ReturnType<typeof commitControlEvents> {
    return commitControlEvents(this, ...args);
  }

  decideAdmissionNow(): ReturnType<typeof decideAdmissionNow> {
    return decideAdmissionNow(this);
  }

  broadcastToClients(
    ...args: HostArgs<typeof broadcastToClients>
  ): ReturnType<typeof broadcastToClients> {
    return broadcastToClients(this, ...args);
  }

  drainOutboxNow(): ReturnType<typeof drainOutboxNow> {
    return drainOutboxNow(this);
  }

  // bridge-sockets.ts
  openBridgeSocket(
    ...args: HostArgs<typeof openBridgeSocket>
  ): ReturnType<typeof openBridgeSocket> {
    return openBridgeSocket(this, ...args);
  }

  closeAttachedBridges(): ReturnType<typeof closeAttachedBridges> {
    return closeAttachedBridges(this);
  }

  handleBridgeUpgrade(
    ...args: HostArgs<typeof handleBridgeUpgrade>
  ): ReturnType<typeof handleBridgeUpgrade> {
    return handleBridgeUpgrade(this, ...args);
  }

  currentBridge(...args: HostArgs<typeof currentBridge>): ReturnType<typeof currentBridge> {
    return currentBridge(this, ...args);
  }

  override webSocketClose(
    ...args: HostArgs<typeof webSocketClose>
  ): ReturnType<typeof webSocketClose> {
    return webSocketClose(this, ...args);
  }

  // client-sockets.ts
  handleClientUpgrade(
    ...args: HostArgs<typeof handleClientUpgrade>
  ): ReturnType<typeof handleClientUpgrade> {
    return handleClientUpgrade(this, ...args);
  }

  handleClientFrame(
    ...args: HostArgs<typeof handleClientFrame>
  ): ReturnType<typeof handleClientFrame> {
    return handleClientFrame(this, ...args);
  }

  // task-branch.ts
  nameTaskBranch(...args: HostArgs<typeof nameTaskBranch>): ReturnType<typeof nameTaskBranch> {
    return nameTaskBranch(this, ...args);
  }

  // session-secrets.ts
  pinDeclaration(...args: HostArgs<typeof pinDeclaration>): ReturnType<typeof pinDeclaration> {
    return pinDeclaration(this, ...args);
  }

  requestLaunchSecrets(
    ...args: HostArgs<typeof requestLaunchSecrets>
  ): ReturnType<typeof requestLaunchSecrets> {
    return requestLaunchSecrets(this, ...args);
  }

  requestApprovedSecret(
    ...args: HostArgs<typeof requestApprovedSecret>
  ): ReturnType<typeof requestApprovedSecret> {
    return requestApprovedSecret(this, ...args);
  }

  sendSecretGrant(...args: HostArgs<typeof sendSecretGrant>): ReturnType<typeof sendSecretGrant> {
    return sendSecretGrant(this, ...args);
  }

  readSecretGrantDeadlineMs(): ReturnType<typeof readSecretGrantDeadlineMs> {
    return readSecretGrantDeadlineMs(this);
  }

  computeSecretGrantDeadlineMs(): ReturnType<typeof computeSecretGrantDeadlineMs> {
    return computeSecretGrantDeadlineMs(this);
  }

  settleUnansweredSecretGrants(
    ...args: HostArgs<typeof settleUnansweredSecretGrants>
  ): ReturnType<typeof settleUnansweredSecretGrants> {
    return settleUnansweredSecretGrants(this, ...args);
  }

  ensureRedactor(...args: HostArgs<typeof ensureRedactor>): ReturnType<typeof ensureRedactor> {
    return ensureRedactor(this, ...args);
  }

  recordSecretsSettled(
    ...args: HostArgs<typeof recordSecretsSettled>
  ): ReturnType<typeof recordSecretsSettled> {
    return recordSecretsSettled(this, ...args);
  }

  isSecretWithholding(
    ...args: HostArgs<typeof isSecretWithholding>
  ): ReturnType<typeof isSecretWithholding> {
    return isSecretWithholding(this, ...args);
  }

  // approval-gate.ts
  admitApproval(...args: HostArgs<typeof admitApproval>): ReturnType<typeof admitApproval> {
    return admitApproval(this, ...args);
  }

  sendApprovalFrame(
    ...args: HostArgs<typeof sendApprovalFrame>
  ): ReturnType<typeof sendApprovalFrame> {
    return sendApprovalFrame(this, ...args);
  }

  tellBridgeOfApproval(
    ...args: HostArgs<typeof tellBridgeOfApproval>
  ): ReturnType<typeof tellBridgeOfApproval> {
    return tellBridgeOfApproval(this, ...args);
  }

  sweepApprovals(...args: HostArgs<typeof sweepApprovals>): ReturnType<typeof sweepApprovals> {
    return sweepApprovals(this, ...args);
  }

  // question-gate.ts
  admitQuestion(...args: HostArgs<typeof admitQuestion>): ReturnType<typeof admitQuestion> {
    return admitQuestion(this, ...args);
  }

  deliverQuestionDecision(
    ...args: HostArgs<typeof deliverQuestionDecision>
  ): ReturnType<typeof deliverQuestionDecision> {
    return deliverQuestionDecision(this, ...args);
  }

  resendQuestionDecision(
    ...args: HostArgs<typeof resendQuestionDecision>
  ): ReturnType<typeof resendQuestionDecision> {
    return resendQuestionDecision(this, ...args);
  }

  sweepQuestions(...args: HostArgs<typeof sweepQuestions>): ReturnType<typeof sweepQuestions> {
    return sweepQuestions(this, ...args);
  }

  // policy.ts
  admitProposal(...args: HostArgs<typeof admitProposal>): ReturnType<typeof admitProposal> {
    return admitProposal(this, ...args);
  }

  admitDescription(
    ...args: HostArgs<typeof admitDescription>
  ): ReturnType<typeof admitDescription> {
    return admitDescription(this, ...args);
  }

  admitCommit(...args: HostArgs<typeof admitCommit>): ReturnType<typeof admitCommit> {
    return admitCommit(this, ...args);
  }

  commitPolicyUpdate(
    ...args: HostArgs<typeof commitPolicyUpdate>
  ): ReturnType<typeof commitPolicyUpdate> {
    return commitPolicyUpdate(this, ...args);
  }

  sendPolicyToBridge(
    ...args: HostArgs<typeof sendPolicyToBridge>
  ): ReturnType<typeof sendPolicyToBridge> {
    return sendPolicyToBridge(this, ...args);
  }

  refuseProposal(...args: HostArgs<typeof refuseProposal>): ReturnType<typeof refuseProposal> {
    return refuseProposal(this, ...args);
  }

  // completion-gate.ts
  judgeVerified(...args: HostArgs<typeof judgeVerified>): ReturnType<typeof judgeVerified> {
    return judgeVerified(this, ...args);
  }

  refuseVerified(...args: HostArgs<typeof refuseVerified>): ReturnType<typeof refuseVerified> {
    return refuseVerified(this, ...args);
  }

  // pull-request.ts
  recordPullRequestState(
    ...args: HostArgs<typeof recordPullRequestState>
  ): ReturnType<typeof recordPullRequestState> {
    return recordPullRequestState(this, ...args);
  }

  lockDownAfterForeignPush(): ReturnType<typeof lockDownAfterForeignPush> {
    return lockDownAfterForeignPush(this);
  }

  maybeOpenPullRequest(
    ...args: HostArgs<typeof maybeOpenPullRequest>
  ): ReturnType<typeof maybeOpenPullRequest> {
    return maybeOpenPullRequest(this, ...args);
  }

  // artifact-uploads.ts
  authorizeAttachmentFetch(
    ...args: HostArgs<typeof authorizeAttachmentFetch>
  ): ReturnType<typeof authorizeAttachmentFetch> {
    return authorizeAttachmentFetch(this, ...args);
  }

  mintArtifactToken(
    ...args: HostArgs<typeof mintArtifactToken>
  ): ReturnType<typeof mintArtifactToken> {
    return mintArtifactToken(this, ...args);
  }

  authorizeUpload(...args: HostArgs<typeof authorizeUpload>): ReturnType<typeof authorizeUpload> {
    return authorizeUpload(this, ...args);
  }

  authorizeArtifact(
    ...args: HostArgs<typeof authorizeArtifact>
  ): ReturnType<typeof authorizeArtifact> {
    return authorizeArtifact(this, ...args);
  }

  completeArtifact(
    ...args: HostArgs<typeof completeArtifact>
  ): ReturnType<typeof completeArtifact> {
    return completeArtifact(this, ...args);
  }

  failArtifact(...args: HostArgs<typeof failArtifact>): ReturnType<typeof failArtifact> {
    return failArtifact(this, ...args);
  }

  readArtifact(...args: HostArgs<typeof readArtifact>): ReturnType<typeof readArtifact> {
    return readArtifact(this, ...args);
  }

  revokeArtifactTokens(
    ...args: HostArgs<typeof revokeArtifactTokens>
  ): ReturnType<typeof revokeArtifactTokens> {
    return revokeArtifactTokens(this, ...args);
  }

  // bridge-dispatch.ts
  readDispatchState(
    ...args: HostArgs<typeof readDispatchState>
  ): ReturnType<typeof readDispatchState> {
    return readDispatchState(this, ...args);
  }

  dispatch(...args: HostArgs<typeof dispatch>): ReturnType<typeof dispatch> {
    return dispatch(this, ...args);
  }

  leavePending(...args: HostArgs<typeof leavePending>): ReturnType<typeof leavePending> {
    return leavePending(this, ...args);
  }

  failRun(...args: HostArgs<typeof failRun>): ReturnType<typeof failRun> {
    return failRun(this, ...args);
  }

  runFailedEvent(...args: Parameters<typeof runFailedEvent>): ReturnType<typeof runFailedEvent> {
    return runFailedEvent(...args);
  }

  revokeTokens(...args: HostArgs<typeof revokeTokens>): ReturnType<typeof revokeTokens> {
    return revokeTokens(this, ...args);
  }

  expireGrants(): ReturnType<typeof expireGrants> {
    return expireGrants(this);
  }

  // publish.ts
  maybePublish(): ReturnType<typeof maybePublish> {
    return maybePublish(this);
  }

  issueCheckpoint(...args: HostArgs<typeof issueCheckpoint>): ReturnType<typeof issueCheckpoint> {
    return issueCheckpoint(this, ...args);
  }

  markPushGrantsSpent(): ReturnType<typeof markPushGrantsSpent> {
    return markPushGrantsSpent(this);
  }

  finishPublish(...args: HostArgs<typeof finishPublish>): ReturnType<typeof finishPublish> {
    return finishPublish(this, ...args);
  }

  // sandbox-lifecycle.ts
  lifecycleView(...args: HostArgs<typeof lifecycleView>): ReturnType<typeof lifecycleView> {
    return lifecycleView(this, ...args);
  }

  moveAttachment(...args: HostArgs<typeof moveAttachment>): ReturnType<typeof moveAttachment> {
    return moveAttachment(this, ...args);
  }

  driverForGeneration(
    ...args: HostArgs<typeof driverForGeneration>
  ): ReturnType<typeof driverForGeneration> {
    return driverForGeneration(this, ...args);
  }

  openCredential(...args: HostArgs<typeof openCredential>): ReturnType<typeof openCredential> {
    return openCredential(this, ...args);
  }

  runLifecycle(): ReturnType<typeof runLifecycle> {
    return runLifecycle(this);
  }

  rearm(): ReturnType<typeof rearm> {
    return rearm(this);
  }

  extendKeepAlive(): ReturnType<typeof extendKeepAlive> {
    return extendKeepAlive(this);
  }

  // sandbox-stop.ts
  stopSandbox(...args: HostArgs<typeof stopSandbox>): ReturnType<typeof stopSandbox> {
    return stopSandbox(this, ...args);
  }

  applyStopPlan(...args: HostArgs<typeof applyStopPlan>): ReturnType<typeof applyStopPlan> {
    return applyStopPlan(this, ...args);
  }

  signalStop(...args: HostArgs<typeof signalStop>): ReturnType<typeof signalStop> {
    return signalStop(this, ...args);
  }

  advanceStop(...args: HostArgs<typeof advanceStop>): ReturnType<typeof advanceStop> {
    return advanceStop(this, ...args);
  }

  revokeGenerationCredentials(
    ...args: HostArgs<typeof revokeGenerationCredentials>
  ): ReturnType<typeof revokeGenerationCredentials> {
    return revokeGenerationCredentials(this, ...args);
  }

  stopGeneration(...args: HostArgs<typeof stopGeneration>): ReturnType<typeof stopGeneration> {
    return stopGeneration(this, ...args);
  }

  // session-state.ts
  archiveSession(...args: HostArgs<typeof archiveSession>): ReturnType<typeof archiveSession> {
    return archiveSession(this, ...args);
  }

  unarchiveSession(): ReturnType<typeof unarchiveSession> {
    return unarchiveSession(this);
  }

  deleteSession(...args: HostArgs<typeof deleteSession>): ReturnType<typeof deleteSession> {
    return deleteSession(this, ...args);
  }

  deletionMarked(): ReturnType<typeof deletionMarked> {
    return deletionMarked(this);
  }

  eraseSession(): ReturnType<typeof eraseSession> {
    return eraseSession(this);
  }

  sessionExists(): ReturnType<typeof sessionExists> {
    return sessionExists(this);
  }

  // resume.ts
  resumeFor(...args: HostArgs<typeof resumeFor>): ReturnType<typeof resumeFor> {
    return resumeFor(this, ...args);
  }

  resumeIfOwed(): ReturnType<typeof resumeIfOwed> {
    return resumeIfOwed(this);
  }

  provisionReplacement(
    ...args: HostArgs<typeof provisionReplacement>
  ): ReturnType<typeof provisionReplacement> {
    return provisionReplacement(this, ...args);
  }

  composeContext(...args: HostArgs<typeof composeContext>): ReturnType<typeof composeContext> {
    return composeContext(this, ...args);
  }

  // provisioning.ts
  createSession(...args: HostArgs<typeof createSession>): ReturnType<typeof createSession> {
    return createSession(this, ...args);
  }

  provisionSandbox(
    ...args: HostArgs<typeof provisionSandbox>
  ): ReturnType<typeof provisionSandbox> {
    return provisionSandbox(this, ...args);
  }

  commitOutputLines(
    ...args: HostArgs<typeof commitOutputLines>
  ): ReturnType<typeof commitOutputLines> {
    return commitOutputLines(this, ...args);
  }

  failProvisioning(
    ...args: HostArgs<typeof failProvisioning>
  ): ReturnType<typeof failProvisioning> {
    return failProvisioning(this, ...args);
  }

  recoverProvisioning(
    ...args: HostArgs<typeof recoverProvisioning>
  ): ReturnType<typeof recoverProvisioning> {
    return recoverProvisioning(this, ...args);
  }

  runLateStops(...args: HostArgs<typeof runLateStops>): ReturnType<typeof runLateStops> {
    return runLateStops(this, ...args);
  }

  stopFailedGenerations(
    ...args: HostArgs<typeof stopFailedGenerations>
  ): ReturnType<typeof stopFailedGenerations> {
    return stopFailedGenerations(this, ...args);
  }

  scheduleLateStop(
    ...args: HostArgs<typeof scheduleLateStop>
  ): ReturnType<typeof scheduleLateStop> {
    return scheduleLateStop(this, ...args);
  }

  // bridge-intake.ts
  handleBridgeFrame(
    ...args: HostArgs<typeof handleBridgeFrame>
  ): ReturnType<typeof handleBridgeFrame> {
    return handleBridgeFrame(this, ...args);
  }

  reactToCommittedFrame(
    ...args: HostArgs<typeof reactToCommittedFrame>
  ): ReturnType<typeof reactToCommittedFrame> {
    return reactToCommittedFrame(this, ...args);
  }
}
