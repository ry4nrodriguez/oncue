// The session object's data shapes: RPC bodies and results, and the rows and
// records its modules pass between them.

import type { BridgeScriptName } from "@oncue/bridge";
import type { EffortLevel, ModelRecord, RuntimeRecord, SessionState } from "@oncue/protocol";
import type { ArtifactKind, ArtifactProducer } from "../../artifacts/policy";
import type { ModalCredential } from "../../modal/client";
import type { DriverOutcome } from "../../sandbox/driver";
import type { FailureInjection } from "../../sandbox/fake-driver";

export interface SessionRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly state: SessionState;
  readonly title: string | null;
  readonly currentRunId: string | null;
  readonly sandboxGeneration: number;
  readonly lastRuntimeSequence: number | null;
}

export interface CreateSessionSecretsRecord {
  readonly baseSha: string;
  readonly pinned: ReadonlyArray<{
    readonly name: string;
    readonly kind: "required" | "optional";
    readonly selected: boolean;
  }>;
  readonly missingRequired: readonly string[];
  /** The project file could not be read exactly and the user started anyway: the session cannot end verified. */
  readonly declarationInvalid: boolean;
}

export interface CreateSessionBody {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly ownerUserId: string;
  readonly title: string | null;
  readonly commandId: string;
  readonly issuedAt: string;
  readonly instruction: {
    readonly messageId: string;
    readonly text: string;
    readonly attachments: readonly unknown[];
  };
  readonly model: Record<string, unknown>;
  /** The harness the Worker resolved (`runtime/resolve.ts`). Absent from older Workers, which means OpenCode. */
  readonly runtime?: RuntimeRecord;
  readonly continuesRunId: string | null;
  /** The user's request to skip the required checks. Absent means false. */
  readonly skipRequiredChecks?: boolean;
  /** "Allow for this session" chosen before the session existed (record 09). Absent means ask. */
  readonly approvalMode?: "ask" | "session";
  readonly mintedRunId: string;
  readonly scriptName: BridgeScriptName;
  /**
   * The task branch and the commit it starts from (record 07), both null for a
   * session with no repository. They come in the create body because the object
   * is authoritative from here on.
   */
  readonly taskBranch: string | null;
  readonly baseCommitSha: string | null;
  /**
   * The repository, with the identifiers the object needs to mint the sandbox's
   * git grant itself (record 07). Identifiers only; the App private key stays in
   * the Worker. Stored in `session_repository` so a re-mint after hibernation has
   * its coordinates. Null means no git grant is ever planned.
   */
  readonly repository: CreateSessionRepository | null;
  readonly redactionSecrets: readonly string[];
  /**
   * What the launch disclosed (record 08), as the Worker re-derived it from the
   * project file: the commit, each declared name and whether it is supplied, and
   * the required names the user started without. Names only; null means none.
   */
  readonly secrets?: CreateSessionSecretsRecord | null | undefined;
  /**
   * Milliseconds between scripted bridge frames, or null to emit them at once.
   * Ephemeral frames are never replayed, so an unpaced script finishes before a
   * browser can connect and see its deltas. Tests pass null for determinism.
   */
  readonly framePacingMs: number | null;
  /** Always `{}` from the real create route; a test seam that makes driver failures reachable without Modal. */
  readonly driverFailures: FailureInjection;
  /**
   * The workspace's Modal token pair, or null when it has not connected Modal
   * (record 02). The create route opens it for this call. The object opens its
   * own copy (`openCredential`) when it needs a driver and has none in hand: a
   * failed provisioning's cleanup, a stop step, the alarm's probe, and a resume.
   * The object is long-lived, so each decryption is a place a credential could
   * come to rest: it reaches one driver call and is never written to SQLite, an
   * event, or a field.
   */
  readonly modalCredential: ModalCredential | null;
}

export interface CreateSessionRepository {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly fullName: string;
  readonly cloneUrl: string;
  /**
   * Null: the branch is named at the first push (record 07). Set from creation
   * for a session working directly on an existing branch.
   */
  readonly taskBranch: string | null;
  readonly baseSha: string;
  /**
   * The base branch a draft pull request targets and this app's origin for the
   * link back. Older sessions have neither and never open a pull request.
   */
  readonly baseBranch?: string;
  readonly appOrigin?: string;
  /**
   * The user chose to work directly on `taskBranch`, an existing branch, rather
   * than a new `oncue/` one. Absent on every other session.
   */
  readonly existingBranch?: true;
}

/** What `planAndCommit` inserts with the first command when the session row does not exist yet. */
export interface NewSessionRow {
  readonly taskId: string | null;
  readonly repository: CreateSessionRepository | null;
  readonly runtimeId: string;
}

export interface CreateSessionResult {
  readonly sessionId: string;
  readonly runId: string;
  /** `deleted`: a delete reached this object first, so nothing was made. */
  readonly plan: "accept" | "reject" | "already_processed" | "deleted";
}

/** What the pull request webhook read off a verified delivery. `actor` is GitHub's login, untrusted text. */
export interface PullRequestStateBody {
  readonly number: number;
  readonly to: "draft" | "open" | "closed" | "merged";
  readonly actor: string;
  readonly mergedSha: string | null;
  readonly changedAt: string;
}

/** `POST /internal/stop`: the credential travels in the body for the same reason as at create. */
export interface StopSandboxBody {
  readonly requestedByUserId: string;
  /** The pair the stop route opened, or null when it could not. Undefined means open it here if a step needs it. */
  readonly modalCredential: ModalCredential | null | undefined;
}

export type StopSandboxResult =
  | { readonly kind: "stopped"; readonly generation: number }
  /** The stop is under way but has not ended the sandbox yet. */
  | { readonly kind: "stopping"; readonly generation: number }
  | { readonly kind: "not_running" }
  | { readonly kind: "failed"; readonly category: string; readonly message: string };

export interface ArchiveSessionBody {
  readonly requestedByUserId: string;
  /** As for the stop: the route's pair, null when it could not open one, absent to open it here. */
  readonly modalCredential?: ModalCredential | null;
  /** The user confirmed that archiving cancels the run still open. */
  readonly cancelOpenRun: boolean;
}

export type ArchiveSessionResult =
  | { readonly kind: "no_session" }
  | { readonly kind: "deleting" }
  /** A run is open and the caller did not confirm cancelling it. */
  | { readonly kind: "run_open" }
  | { readonly kind: "archived"; readonly sandbox: StopSandboxResult["kind"] };

export type UnarchiveSessionResult =
  | { readonly kind: "no_session" }
  | { readonly kind: "deleting" }
  | { readonly kind: "active" };

export interface DeleteSessionBody {
  readonly requestedByUserId: string;
  readonly modalCredential?: ModalCredential | null;
}

export type DeleteSessionResult =
  | { readonly kind: "no_session" }
  | { readonly kind: "deleting"; readonly sandbox: StopSandboxResult["kind"] };

export type EraseSessionResult =
  | { readonly kind: "erased" }
  | { readonly kind: "not_deleting" }
  /** The sandbox has not stopped yet; the job asks again later. */
  | { readonly kind: "stopping" };

export type KeepAliveResult =
  | { readonly kind: "extended"; readonly expiresAt: string }
  | { readonly kind: "not_running" };

export interface ArtifactAuthorizeBody {
  readonly artifactId: string;
  readonly token: string;
  readonly purpose: "upload" | "restore";
}

export type ArtifactAuthorizeResult =
  | {
      readonly kind: "authorized";
      readonly objectKey: string;
      readonly contentType: string;
      readonly declaredBytes: number;
    }
  | { readonly kind: "refused" };

export interface ArtifactCompleteBody {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/** What the upload endpoint projects into D1's `artifact_index` once `artifact.created` is committed. */
export interface ArtifactIndexRow {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: ArtifactKind;
  readonly producer: ArtifactProducer;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly classification: "essential_evidence" | "temporary";
  readonly objectKey: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export type ArtifactCompleteResult =
  | { readonly kind: "created"; readonly index: ArtifactIndexRow }
  | { readonly kind: "refused" };

export interface ArtifactFailBody {
  readonly artifactId: string;
  readonly stage: "upload" | "validate";
  readonly reason: string;
}

export type ArtifactReadResult =
  | {
      readonly kind: "found";
      readonly objectKey: string;
      readonly contentType: string;
      readonly artifactKind: ArtifactKind;
      readonly byteSize: number;
    }
  | { readonly kind: "not_found" };

export type DriverFailure = Extract<DriverOutcome<unknown>, { readonly kind: "error" }>;

/** How a new generation starts: the first, a resume after a stop or a loss, or the ceiling's replacement. */
export interface GenerationStart {
  readonly reason: "initial" | "resume" | "replacement";
  readonly replaced: {
    readonly previousGeneration: number;
    readonly restoredFrom: string | null;
  } | null;
  readonly context: string | null;
  /** Called once the new generation's `sandbox.provisioning` is committed, so a second resume can join it. */
  readonly committed: () => void;
  /**
   * Made before the caller's last check, so nothing is awaited between that
   * check and the commit of `sandbox.provisioning`.
   */
  readonly bootstrap: BootstrapCredential;
}

export interface BootstrapCredential {
  readonly credential: string;
  readonly sha256: string;
}

/**
 * What a bridge socket keeps across hibernation: the origin it dialed (put on
 * every model grant) and whether it finished the handshake. Only a negotiated
 * socket is sent frames, so the fake driver's in-process socket never is.
 */
export interface BridgeAttachment {
  readonly origin: string;
  readonly negotiated: boolean;
}

/** The `session_repository` row's base commit and task branch, null until the first push names it. */
export type RepositoryBase = { readonly baseSha: string; readonly taskBranch: string | null };

/** A run's model record as read back: `effort` is always present (`findRunModel`). */
export type RunModel = ModelRecord & { readonly effort: EffortLevel | null };
