/**
 * The post-handshake frames of the object <-> bridge channel. Pure and
 * Node-free: the Worker imports these through `@oncue/bridge`'s index to build
 * and parse the same wire shape. No runtime, supervisor, or git type is
 * exported from here.
 */

import {
  ATTACHMENT_LIMITS,
  type CommandType,
  DEFAULT_RUNTIME_ID,
  EFFORT_LEVELS,
  type EffortLevel,
  isCommandType,
  LIMITS,
  type PayloadOf,
  type ProtocolCommand,
  parseCommandPayload,
  QUESTION_LIMITS,
} from "@oncue/protocol";
import type { QuestionOutcome } from "./questions";
import { MAX_SECRETS, refuseSecretName, refuseSecretValue } from "./secret-names";

/** The six commands the bridge can act on; every other command type is handled entirely in the object. */
export type DeliverableCommandType =
  | "run.start"
  | "run.follow_up"
  | "run.cancel"
  | "agent.stop"
  | "checkpoint.create"
  | "runtime.shutdown";

const DELIVERABLE_COMMAND_TYPES: ReadonlySet<string> = new Set<DeliverableCommandType>([
  "run.start",
  "run.follow_up",
  "run.cancel",
  "agent.stop",
  "checkpoint.create",
  "runtime.shutdown",
]);

/**
 * Narrowed in the type system so a command the object starts forwarding
 * before the bridge knows it is a compile error, not an `unsupported` ack.
 */
export type DeliverableCommand = Extract<
  ProtocolCommand,
  { readonly type: DeliverableCommandType }
>;

/**
 * A command the object has already admitted and committed; the bridge's ack is
 * a second acknowledgement (record 04), never a request for permission. The
 * bridge keys idempotency on `command.commandId`.
 */
export interface CommandFrame {
  readonly type: "bridge.command";
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly command: DeliverableCommand;
  /**
   * The run every event the bridge emits for this command carries. For
   * `run.start` it is the run the object minted on admission, which the
   * command itself cannot name. Null only for `runtime.shutdown`.
   */
  readonly runId: string | null;
  /**
   * Record 11's durable context summary, set only on the first `run.start` of
   * a resumed or replacement generation and prepended to the prompt. It is not
   * part of the committed command because the user did not write it.
   */
  readonly context: string | null;
  /**
   * One fetch per attachment, each with a one-time bearer minted for this
   * frame; a redelivery mints again. Absent reads as none. Never logged:
   * `token` is a credential.
   */
  readonly attachments?: readonly AttachmentFetch[];
}

/** One attachment the bridge fetches into the sandbox before it prompts. */
export interface AttachmentFetch {
  readonly artifactId: string;
  /** The person's file name, cleaned by the control plane. Display only; the bridge picks its own path. */
  readonly name: string;
  /** From the bytes, as the control plane recorded them. */
  readonly contentType: string;
  readonly byteSize: number;
  readonly url: string;
  /** Single use, minted by the object for this one attachment. */
  readonly token: string;
}

/** As many as a message may carry (`ATTACHMENT_LIMITS.perMessage`). */
export const MAX_ATTACHMENT_FETCHES = ATTACHMENT_LIMITS.perMessage;

interface GrantEnvelope {
  readonly type: "bridge.grant";
  /** Idempotency key and ack reference. Minted by the object. */
  readonly grantId: string;
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  /** Advisory to the bridge; the broker and GitHub enforce their own. Lets a log line say "expired" without the token being near the log. */
  readonly expiresAt: string;
}

export interface ModelGrantSpec {
  readonly name: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly effortLevels: readonly EffortLevel[] | null;
  /**
   * Whether the model reads images. False sends images to the agent as files
   * to read rather than as pictures. Absent reads as false.
   */
  readonly imageInput: boolean;
}

/** Another model the session may change to, with the catalog's facts for it (record 15). */
export interface ModelGrantCatalogEntry {
  readonly provider: string;
  readonly modelId: string;
  readonly spec: ModelGrantSpec;
}

export interface ModelGrantFrame extends GrantEnvelope {
  readonly kind: "model";
  /** A Model Broker token (`ot1.…`). Goes straight to the relay holder; never into `AgentState`, never logged. */
  readonly token: string;
  readonly brokerOrigin: string;
  /** The provider and the provider's own model id. Each runtime adapter names them in its harness's terms. */
  readonly model: { readonly provider: string; readonly modelId: string };
  /**
   * The session's harness. Absent means OpenCode. Unchecked here: the reducer
   * refuses a runtime this image does not carry.
   */
  readonly runtime: string;
  /** The current run's effort, in the provider's own word; `null` for a model with none. */
  readonly effort: EffortLevel | null;
  /**
   * The catalog's limits and effort levels for the model, so a model newer
   * than the runtime's own list still runs. `null` when the catalog has no row.
   */
  readonly modelSpec: ModelGrantSpec | null;
  /**
   * Every model a later run of this session could be changed to. A harness
   * that takes a model per prompt is configured for all of them when it
   * starts, since its configuration is read once. The token still names one
   * model, and the Model Broker refuses any other. Absent from an older object,
   * which reads as none.
   */
  readonly catalog?: readonly ModelGrantCatalogEntry[] | undefined;
  /**
   * Whether a git grant will follow. The runtime starts only after the clone
   * (record 02), so the bridge needs this stated rather than inferred from a
   * grant that never arrives.
   */
  readonly workspace: "repository" | "none";
}

/** A one-time download of a recovery patch bundle, applied right after the clone. */
export interface RestoreBundle {
  readonly artifactId: string;
  readonly url: string;
  /** Single use, minted by the object for this one artifact. */
  readonly token: string;
}

export interface GitGrantFrame extends GrantEnvelope {
  readonly kind: "git";
  /** A GitHub installation token, `contents: read` on one repository. Single use: the clone. */
  readonly token: string;
  readonly repository: { readonly fullName: string; readonly cloneUrl: string };
  /** The branch to clone: the session's task branch once it has one, its base branch before. */
  readonly branch: string;
  /** The session's task branch, or null until a push grant's ref names it. */
  readonly taskBranch: string | null;
  /** Where the session branched from. Fixed for the session's life. */
  readonly baseSha: string;
  /** The commit the clone must land on: the last checkpoint pushed, or `baseSha` before any. */
  readonly headSha: string;
  readonly restore: RestoreBundle | null;
}

/**
 * Record 07's checkpoint push: a `contents: write` token GitHub cannot narrow
 * to a ref, so the bridge refuses any push whose destination is not exactly
 * `ref` and revokes the token after its one push. The object revokes it again
 * at stop, so a lost report leaves no live token.
 */
export interface PushGrantFrame extends GrantEnvelope {
  readonly kind: "push";
  readonly token: string;
  readonly repository: { readonly fullName: string; readonly cloneUrl: string };
  /** `refs/heads/<session branch>`, and nothing else. */
  readonly ref: string;
  /** The remote head the checkpoint commit is parented on, so the push is a fast-forward. */
  readonly parentSha: string;
}

/** Record 03's controlled upload: a one-time bearer for one declared artifact, answering `artifact.uploading`. */
export interface UploadGrantFrame extends GrantEnvelope {
  readonly kind: "upload";
  readonly token: string;
  readonly artifactId: string;
  readonly url: string;
  readonly maxBytes: number;
}

/**
 * Development secrets for the agent (records 04 and 08). `requestRef` is null
 * for the names confirmed at launch, or names the waiting tool call the user
 * approved. The values go to the supervisor, which writes them where only the
 * agent reads, and stay in the bridge's memory for redaction only: never in
 * `AgentState`, a bridge file, its environment, or a log line. Acknowledged
 * only once written, so the object's "supplied" means the file is there.
 */
export interface SecretGrantFrame extends GrantEnvelope {
  readonly kind: "secret";
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly requestRef: string | null;
}

/** As many as a project file may declare. */
export const MAX_GRANTED_SECRETS = MAX_SECRETS;

/** Closed: adding a credential kind is a record 04 decision, not a payload field. */
export type GrantFrame =
  | ModelGrantFrame
  | GitGrantFrame
  | PushGrantFrame
  | UploadGrantFrame
  | SecretGrantFrame;

export type SessionPolicy = PayloadOf<"policy.updated">["to"];

/**
 * The Git policy in force, sent when the runtime is ready and on every change
 * so a `policy.proposed` names the version it was made against. Advisory: the
 * object judges proposals against its own row. Never acknowledged and never
 * caused by a bridge frame, so it cannot loop.
 */
export interface PolicyFrame {
  readonly type: "bridge.policy";
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly policy: SessionPolicy;
}

/**
 * What became of an approval the bridge asked for. `requestRef` is the
 * bridge's own id for the waiting tool call. `pending` carries the expiry so
 * the bridge can reject the call on time even with the socket down. An
 * approval arrives as a `secret` grant instead; `unavailable` means the user
 * approved but no value could be opened. Never acknowledged, so it cannot loop.
 */
/**
 * What became of a forwarded request. `allowed` answers only a permission ask
 * (record 09); a secret is never released by a word, only by its grant.
 */
export type ApprovalOutcome =
  | "pending"
  | "allowed"
  | "refused"
  | "unavailable"
  | "denied"
  | "expired";
const APPROVAL_OUTCOMES: readonly string[] = [
  "pending",
  "allowed",
  "refused",
  "unavailable",
  "denied",
  "expired",
];

export interface ApprovalFrame {
  readonly type: "bridge.approval";
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly requestRef: string;
  readonly outcome: ApprovalOutcome;
  /** Set on `pending` only. */
  readonly expiresAt: string | null;
}

/**
 * What became of a question the bridge asked (`question.asked`). `requestRef`
 * is the bridge's own id for it. `answered` carries one list of answers per
 * question; `dismissed` is the user's dismissal (or a message sent instead);
 * `refused` is the object declining to show it. Never acknowledged, so it
 * cannot loop; the object sends a decision again when the bridge reconnects.
 */
export interface QuestionFrame {
  readonly type: "bridge.question";
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly requestRef: string;
  readonly outcome: QuestionOutcome;
  /** Set on `answered` only. */
  readonly answers: readonly (readonly string[])[] | null;
}

const QUESTION_OUTCOMES: readonly string[] = ["answered", "dismissed", "refused"];

/** A union rather than two optional fields, so "an ack for neither" and "for both" are unrepresentable. */
export type AckRef = { readonly commandId: string } | { readonly grantId: string };

export type AckRejection =
  /** The bridge is not in a state where this means anything: a cancel with no run, a git grant after the clone. */
  | "wrong_state"
  /** A NEW commandId whose `instruction.messageId` was already prompted in this process. A redelivered commandId is not this; it gets the earlier ack replayed. */
  | "duplicate"
  /** OpenCode is not ready, or has exited. Reachable when a generation races a shutdown; the object otherwise gates on `runtime.ready`. */
  | "no_runtime"
  /** A command type this bridge build does not know. Image older than the control plane. */
  | "unsupported"
  /** The frame did not parse, or named another session or generation. */
  | "malformed";

/** `accepted` carries no reason; a rejection always carries one. */
export type AckOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: AckRejection };

/** Receipt, not result. An `accepted` ack means the bridge took responsibility; what happened next is only ever visible as protocol events. */
export interface AckFrame {
  readonly type: "bridge.ack";
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly ref: AckRef;
  readonly outcome: AckOutcome;
}

export interface FrameIdentity {
  readonly sessionId: string;
  readonly generation: number;
}

/**
 * A frame after the handshake. Identity is checked here, not in the reducer: a
 * frame naming another session or generation becomes a `malformed` ack when it
 * carries an id, and a log line when it does not.
 */
export type SessionFrame =
  | { readonly kind: "command"; readonly frame: CommandFrame }
  | { readonly kind: "grant"; readonly frame: GrantFrame }
  | { readonly kind: "policy"; readonly policy: SessionPolicy }
  | {
      readonly kind: "approval";
      readonly requestRef: string;
      readonly outcome: ApprovalOutcome;
      readonly expiresAt: string | null;
    }
  | {
      readonly kind: "question";
      readonly requestRef: string;
      readonly outcome: QuestionOutcome;
      readonly answers: readonly (readonly string[])[] | null;
    }
  | { readonly kind: "malformed"; readonly ref: AckRef | null; readonly detail: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function malformed(ref: AckRef | null, detail: string): SessionFrame {
  return { kind: "malformed", ref, detail };
}

function identityMatches(
  identity: FrameIdentity,
  sessionId: unknown,
  sandboxGeneration: unknown,
): boolean {
  return sessionId === identity.sessionId && sandboxGeneration === identity.generation;
}

function parseDeliverableCommand(
  raw: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: DeliverableCommand }
  | { readonly ok: false; readonly commandId: string | null; readonly detail: string } {
  const commandId = typeof raw.commandId === "string" ? raw.commandId : null;
  const type = raw.type;
  if (typeof type !== "string" || !isCommandType(type)) {
    return { ok: false, commandId, detail: `unknown command type: ${String(type)}` };
  }
  if (!DELIVERABLE_COMMAND_TYPES.has(type)) {
    // A command the object never forwards: its arrival is a bug upstream, and
    // the bridge still does not act on it.
    return {
      ok: false,
      commandId,
      detail: `command type is not deliverable to the bridge: ${type}`,
    };
  }
  const sessionId = raw.sessionId;
  const issuedAt = raw.issuedAt;
  const issuedByUserId = raw.issuedByUserId;
  const runId = raw.runId;
  const expected = asRecord(raw.expected);
  if (
    commandId === null ||
    typeof sessionId !== "string" ||
    typeof issuedAt !== "string" ||
    typeof issuedByUserId !== "string" ||
    expected === null
  ) {
    return { ok: false, commandId, detail: "command envelope is missing a required field" };
  }
  const payloadResult = parseCommandPayload(type as CommandType, raw.payload);
  if (!payloadResult.ok) {
    return { ok: false, commandId, detail: `command payload rejected: ${payloadResult.reason}` };
  }
  const command = {
    commandId,
    sessionId,
    runId: typeof runId === "string" ? runId : null,
    issuedAt,
    issuedByUserId,
    expected,
    type,
    payload: payloadResult.value,
  } as DeliverableCommand;
  return { ok: true, value: command };
}

function parseCommandFrame(identity: FrameIdentity, raw: Record<string, unknown>): SessionFrame {
  const parsed = parseDeliverableCommand(asRecord(raw.command) ?? {});
  const ref: AckRef | null = parsed.ok
    ? { commandId: parsed.value.commandId }
    : parsed.commandId !== null
      ? { commandId: parsed.commandId }
      : null;
  if (!identityMatches(identity, raw.sessionId, raw.sandboxGeneration)) {
    return malformed(ref, "frame named another session or generation");
  }
  if (!parsed.ok) {
    return malformed(ref, parsed.detail);
  }
  const runId = raw.runId;
  if (runId !== null && typeof runId !== "string") {
    return malformed(ref, "frame run id is neither a string nor null");
  }
  if (parsed.value.type === "run.start" && runId === null) {
    return malformed(ref, "run.start frame names no run");
  }
  if (parsed.value.runId !== null && runId !== parsed.value.runId) {
    return malformed(ref, "frame run id disagrees with the command's run");
  }
  const context = raw.context ?? null;
  if (context !== null && typeof context !== "string") {
    return malformed(ref, "frame context is neither a string nor null");
  }
  const attachments = parseAttachmentFetches(raw.attachments);
  if (attachments === null) {
    return malformed(ref, "frame attachments are not a list of fetches");
  }
  return {
    kind: "command",
    frame: {
      type: "bridge.command",
      sessionId: identity.sessionId,
      sandboxGeneration: identity.generation,
      command: parsed.value,
      runId,
      context,
      ...(attachments.length === 0 ? {} : { attachments }),
    },
  };
}

/** `[]` when absent; null when present and not a list of well-formed fetches. */
function parseAttachmentFetches(raw: unknown): readonly AttachmentFetch[] | null {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENT_FETCHES) {
    return null;
  }
  const fetches: AttachmentFetch[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (
      entry === null ||
      typeof entry.artifactId !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.contentType !== "string" ||
      typeof entry.byteSize !== "number" ||
      typeof entry.url !== "string" ||
      typeof entry.token !== "string"
    ) {
      return null;
    }
    fetches.push({
      artifactId: entry.artifactId,
      name: entry.name,
      contentType: entry.contentType,
      byteSize: entry.byteSize,
      url: entry.url,
      token: entry.token,
    });
  }
  return fetches;
}

function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** `undefined` when the grant's spec is malformed; `null` when it says there is none. */
function parseModelGrantSpec(raw: unknown): ModelGrantSpec | null | undefined {
  if (raw === null || raw === undefined) {
    return null;
  }
  const spec = asRecord(raw);
  if (spec === null) {
    return undefined;
  }
  const levels = spec.effortLevels;
  const imageInput = spec.imageInput ?? false;
  if (
    typeof spec.name !== "string" ||
    typeof spec.contextWindow !== "number" ||
    typeof spec.maxOutput !== "number" ||
    !(levels === null || (Array.isArray(levels) && levels.every(isEffortLevel))) ||
    typeof imageInput !== "boolean"
  ) {
    return undefined;
  }
  return {
    name: spec.name,
    contextWindow: spec.contextWindow,
    maxOutput: spec.maxOutput,
    effortLevels: levels === null ? null : [...levels],
    imageInput,
  };
}

/** `undefined` when the grant's catalog is malformed; empty when it carries none. */
function parseModelGrantCatalog(raw: unknown): ModelGrantCatalogEntry[] | undefined {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entries: ModelGrantCatalogEntry[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const spec = entry === null ? undefined : parseModelGrantSpec(entry.spec);
    if (
      entry === null ||
      typeof entry.provider !== "string" ||
      typeof entry.modelId !== "string" ||
      spec === undefined ||
      spec === null
    ) {
      return undefined;
    }
    entries.push({ provider: entry.provider, modelId: entry.modelId, spec });
  }
  return entries;
}

function parseModelGrant(raw: Record<string, unknown>, base: GrantEnvelope): SessionFrame | null {
  const model = asRecord(raw.model);
  // Older objects send OpenCode's `providerID` and `modelID`; newer ones send
  // both spellings so an older bridge still parses the grant.
  const provider = model?.provider ?? model?.providerID;
  const modelId = model?.modelId ?? model?.modelID;
  const runtime = raw.runtime === undefined ? DEFAULT_RUNTIME_ID : raw.runtime;
  // Absent `effort` and `modelSpec` read as none; a wrong shape is refused.
  const effort = raw.effort === undefined ? null : raw.effort;
  const modelSpec = parseModelGrantSpec(raw.modelSpec);
  const catalog = parseModelGrantCatalog(raw.catalog);
  if (
    typeof raw.token !== "string" ||
    typeof raw.brokerOrigin !== "string" ||
    typeof provider !== "string" ||
    typeof modelId !== "string" ||
    typeof runtime !== "string" ||
    !(effort === null || isEffortLevel(effort)) ||
    modelSpec === undefined ||
    catalog === undefined ||
    (raw.workspace !== "repository" && raw.workspace !== "none")
  ) {
    return null;
  }
  return {
    kind: "grant",
    frame: {
      ...base,
      kind: "model",
      token: raw.token,
      brokerOrigin: raw.brokerOrigin,
      model: { provider, modelId },
      runtime,
      effort,
      modelSpec,
      // Left out when empty, so a grant that lists none reads as it always did.
      ...(catalog.length === 0 ? {} : { catalog }),
      workspace: raw.workspace,
    },
  };
}

function parseRepository(
  raw: Record<string, unknown>,
): { readonly fullName: string; readonly cloneUrl: string } | null {
  const repository = asRecord(raw.repository);
  const fullName = repository?.fullName;
  const cloneUrl = repository?.cloneUrl;
  return typeof fullName === "string" && typeof cloneUrl === "string"
    ? { fullName, cloneUrl }
    : null;
}

/** `undefined` when the field is present and not a bundle, which is malformed rather than absent. */
function parseRestore(value: unknown): RestoreBundle | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  const restore = asRecord(value);
  if (
    restore === null ||
    typeof restore.artifactId !== "string" ||
    typeof restore.url !== "string" ||
    typeof restore.token !== "string"
  ) {
    return undefined;
  }
  return { artifactId: restore.artifactId, url: restore.url, token: restore.token };
}

function parseGitGrant(raw: Record<string, unknown>, base: GrantEnvelope): SessionFrame | null {
  const repository = parseRepository(raw);
  const restore = parseRestore(raw.restore);
  if (
    typeof raw.token !== "string" ||
    repository === null ||
    typeof raw.branch !== "string" ||
    typeof raw.baseSha !== "string" ||
    (raw.headSha !== undefined && typeof raw.headSha !== "string") ||
    (raw.taskBranch !== undefined &&
      raw.taskBranch !== null &&
      typeof raw.taskBranch !== "string") ||
    restore === undefined
  ) {
    return null;
  }
  return {
    kind: "grant",
    frame: {
      ...base,
      kind: "git",
      token: raw.token,
      repository,
      branch: raw.branch,
      // No `taskBranch` means an older object, whose clone branch is the task branch.
      taskBranch: raw.taskBranch === undefined ? raw.branch : (raw.taskBranch as string | null),
      baseSha: raw.baseSha,
      // An older object names no head: its clone is always at the base.
      headSha: typeof raw.headSha === "string" ? raw.headSha : raw.baseSha,
      restore,
    },
  };
}

function parsePushGrant(raw: Record<string, unknown>, base: GrantEnvelope): SessionFrame | null {
  const repository = parseRepository(raw);
  if (
    typeof raw.token !== "string" ||
    repository === null ||
    typeof raw.ref !== "string" ||
    typeof raw.parentSha !== "string"
  ) {
    return null;
  }
  return {
    kind: "grant",
    frame: {
      ...base,
      kind: "push",
      token: raw.token,
      repository,
      ref: raw.ref,
      parentSha: raw.parentSha,
    },
  };
}

function parseUploadGrant(raw: Record<string, unknown>, base: GrantEnvelope): SessionFrame | null {
  if (
    typeof raw.token !== "string" ||
    typeof raw.artifactId !== "string" ||
    typeof raw.url !== "string" ||
    typeof raw.maxBytes !== "number" ||
    !Number.isInteger(raw.maxBytes) ||
    raw.maxBytes <= 0
  ) {
    return null;
  }
  return {
    kind: "grant",
    frame: {
      ...base,
      kind: "upload",
      token: raw.token,
      artifactId: raw.artifactId,
      url: raw.url,
      maxBytes: raw.maxBytes,
    },
  };
}

/** The names and values pass the rules root will apply again; a frame that would be refused there is malformed here. */
function parseSecretGrant(raw: Record<string, unknown>, base: GrantEnvelope): SessionFrame | null {
  const { secrets, requestRef } = raw;
  if (requestRef !== null && typeof requestRef !== "string") {
    return null;
  }
  if (!Array.isArray(secrets) || secrets.length === 0 || secrets.length > MAX_GRANTED_SECRETS) {
    return null;
  }
  const parsed: { name: string; value: string }[] = [];
  for (const entry of secrets) {
    const record = asRecord(entry);
    if (record === null || typeof record.name !== "string" || typeof record.value !== "string") {
      return null;
    }
    if (refuseSecretName(record.name) !== null || refuseSecretValue(record.value) !== null) {
      return null;
    }
    parsed.push({ name: record.name, value: record.value });
  }
  return { kind: "grant", frame: { ...base, kind: "secret", secrets: parsed, requestRef } };
}

const GRANT_PARSERS: Readonly<
  Record<
    GrantFrame["kind"],
    (raw: Record<string, unknown>, base: GrantEnvelope) => SessionFrame | null
  >
> = {
  model: parseModelGrant,
  git: parseGitGrant,
  push: parsePushGrant,
  upload: parseUploadGrant,
  secret: parseSecretGrant,
};

function parseGrantFrame(identity: FrameIdentity, raw: Record<string, unknown>): SessionFrame {
  const grantId = typeof raw.grantId === "string" ? raw.grantId : null;
  const ref: AckRef | null = grantId !== null ? { grantId } : null;
  if (!identityMatches(identity, raw.sessionId, raw.sandboxGeneration)) {
    return malformed(ref, "frame named another session or generation");
  }
  if (grantId === null || typeof raw.expiresAt !== "string") {
    return malformed(ref, "grant envelope is missing a required field");
  }
  const base: GrantEnvelope = {
    type: "bridge.grant",
    grantId,
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
    expiresAt: raw.expiresAt,
  };
  const kind = raw.kind;
  const result =
    typeof kind === "string" && Object.hasOwn(GRANT_PARSERS, kind)
      ? GRANT_PARSERS[kind as GrantFrame["kind"]](raw, base)
      : null;
  if (result === null) {
    return malformed(ref, `grant is missing a required field for kind: ${String(kind)}`);
  }
  return result;
}

/**
 * Parses a post-handshake frame. Wraps `parseCommandPayload` from
 * `@oncue/protocol` for the five deliverable types; a sixth type parses as
 * `malformed` with the commandId as its ref so the object hears `unsupported`
 * rather than silence. Never throws.
 */
export function parseSessionFrame(identity: FrameIdentity, raw: unknown): SessionFrame | null {
  const value = asRecord(raw);
  if (value === null) {
    return null;
  }
  if (value.type === "bridge.command") {
    return parseCommandFrame(identity, value);
  }
  if (value.type === "bridge.grant") {
    return parseGrantFrame(identity, value);
  }
  if (value.type === "bridge.policy") {
    return parsePolicyFrame(identity, value);
  }
  if (value.type === "bridge.approval") {
    return parseApprovalFrame(identity, value);
  }
  if (value.type === "bridge.question") {
    return parseQuestionFrame(identity, value);
  }
  return null;
}

function isAnswerList(value: unknown): value is readonly (readonly string[])[] {
  return (
    Array.isArray(value) &&
    value.length <= QUESTION_LIMITS.questionsPerAsk &&
    value.every(
      (answers) =>
        Array.isArray(answers) &&
        answers.length <= QUESTION_LIMITS.answersPerQuestion &&
        answers.every(
          (answer) => typeof answer === "string" && answer.length <= LIMITS.summaryTextChars,
        ),
    )
  );
}

/** Like an approval frame it carries no id to acknowledge, so a bad one is logged and dropped. */
function parseQuestionFrame(identity: FrameIdentity, value: Record<string, unknown>): SessionFrame {
  if (!identityMatches(identity, value.sessionId, value.sandboxGeneration)) {
    return malformed(null, "a question frame for another session or generation");
  }
  const { requestRef, outcome, answers } = value;
  if (typeof requestRef !== "string" || requestRef.length === 0) {
    return malformed(null, "a question frame with no request reference");
  }
  if (typeof outcome !== "string" || !QUESTION_OUTCOMES.includes(outcome)) {
    return malformed(null, "a question frame with an unknown outcome");
  }
  const answered = outcome === "answered";
  if (answered && !isAnswerList(answers)) {
    return malformed(null, "an answered question frame with unreadable answers");
  }
  return {
    kind: "question",
    requestRef,
    outcome: outcome as QuestionOutcome,
    answers: answered ? (answers as readonly (readonly string[])[]) : null,
  };
}

const POLICY_VALUES: Readonly<Record<string, readonly string[]>> = {
  commit: ["auto", "manual"],
  push: ["auto", "manual", "never"],
  pullRequest: ["auto_after_verification", "manual", "never"],
  planApproval: ["proceed", "wait_for_user"],
  fileEdits: ["allowed", "blocked"],
};

/** Like a policy frame it carries no id to acknowledge, so a bad one is logged and dropped. */
function parseApprovalFrame(identity: FrameIdentity, value: Record<string, unknown>): SessionFrame {
  if (!identityMatches(identity, value.sessionId, value.sandboxGeneration)) {
    return malformed(null, "an approval frame for another session or generation");
  }
  const { requestRef, outcome, expiresAt } = value;
  if (typeof requestRef !== "string" || requestRef.length === 0) {
    return malformed(null, "an approval frame with no request reference");
  }
  if (typeof outcome !== "string" || !APPROVAL_OUTCOMES.includes(outcome)) {
    return malformed(null, "an approval frame with an unknown outcome");
  }
  const pending = outcome === "pending";
  if (pending && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
    return malformed(null, "a pending approval frame with no expiry");
  }
  return {
    kind: "approval",
    requestRef,
    outcome: outcome as ApprovalOutcome,
    expiresAt: pending ? (expiresAt as string) : null,
  };
}

/** A policy frame carries no id to acknowledge, so a bad one is logged and dropped. */
function parsePolicyFrame(identity: FrameIdentity, value: Record<string, unknown>): SessionFrame {
  if (!identityMatches(identity, value.sessionId, value.sandboxGeneration)) {
    return malformed(null, "a policy frame for another session or generation");
  }
  const policy = asRecord(value.policy);
  const wellFormed =
    policy !== null &&
    Number.isSafeInteger(policy.version) &&
    Object.entries(POLICY_VALUES).every(([field, values]) =>
      values.includes(policy[field] as string),
    );
  if (!wellFormed) {
    return malformed(null, "a policy frame with an unreadable policy");
  }
  return {
    kind: "policy",
    policy: {
      version: policy.version,
      commit: policy.commit,
      push: policy.push,
      pullRequest: policy.pullRequest,
      planApproval: policy.planApproval,
      fileEdits: policy.fileEdits,
    } as SessionPolicy,
  };
}

/** The bridge's builder. `identity` is the config's; the ref and outcome are the reducer's. */
export function buildAckFrame(identity: FrameIdentity, ref: AckRef, outcome: AckOutcome): AckFrame {
  return {
    type: "bridge.ack",
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
    ref,
    outcome,
  };
}

/**
 * The object's builders and parser, exported so the Worker cannot hand-roll a
 * frame shape that drifts from what `parseSessionFrame` accepts. One
 * definition of each frame; both sides import it.
 */
export function buildCommandFrame(
  identity: FrameIdentity,
  command: DeliverableCommand,
  runId: string | null,
  context: string | null = null,
  attachments: readonly AttachmentFetch[] = [],
): CommandFrame {
  return {
    type: "bridge.command",
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
    command,
    runId,
    context,
    // Omitted when empty, so an older bridge still parses the frame.
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

export function buildApprovalFrame(
  identity: FrameIdentity,
  requestRef: string,
  outcome: ApprovalOutcome,
  expiresAt: string | null = null,
): ApprovalFrame {
  return {
    type: "bridge.approval",
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
    requestRef,
    outcome,
    expiresAt: outcome === "pending" ? expiresAt : null,
  };
}

export function buildQuestionFrame(
  identity: FrameIdentity,
  requestRef: string,
  outcome: QuestionOutcome,
  answers: readonly (readonly string[])[] | null = null,
): QuestionFrame {
  return {
    type: "bridge.question",
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
    requestRef,
    outcome,
    answers: outcome === "answered" ? (answers ?? []) : null,
  };
}

export function buildPolicyFrame(identity: FrameIdentity, policy: SessionPolicy): PolicyFrame {
  return {
    type: "bridge.policy",
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
    policy,
  };
}

type GrantBody<G extends GrantFrame> = Omit<G, "type" | "sessionId" | "sandboxGeneration">;

export function buildGrantFrame(
  identity: FrameIdentity,
  grant:
    | GrantBody<ModelGrantFrame>
    | GrantBody<GitGrantFrame>
    | GrantBody<PushGrantFrame>
    | GrantBody<UploadGrantFrame>
    | GrantBody<SecretGrantFrame>,
): GrantFrame {
  return {
    ...grant,
    type: "bridge.grant",
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
  } as GrantFrame;
}

/** `null` when the text is not a `bridge.ack` for this identity. The object calls this before `ingestFrame`. */
export function parseAckFrame(identity: FrameIdentity, raw: string): AckFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const value = asRecord(parsed);
  if (value === null || value.type !== "bridge.ack") {
    return null;
  }
  if (!identityMatches(identity, value.sessionId, value.sandboxGeneration)) {
    return null;
  }
  const ref = asRecord(value.ref);
  const commandId = ref?.commandId;
  const grantId = ref?.grantId;
  const parsedRef: AckRef | null =
    typeof commandId === "string"
      ? { commandId }
      : typeof grantId === "string"
        ? { grantId }
        : null;
  if (parsedRef === null) {
    return null;
  }
  const outcome = asRecord(value.outcome);
  if (outcome === null) {
    return null;
  }
  const parsedOutcome = parseAckOutcome(outcome);
  if (parsedOutcome === null) {
    return null;
  }
  return {
    type: "bridge.ack",
    sessionId: identity.sessionId,
    sandboxGeneration: identity.generation,
    ref: parsedRef,
    outcome: parsedOutcome,
  };
}

const ACK_REJECTIONS: ReadonlySet<string> = new Set<AckRejection>([
  "wrong_state",
  "duplicate",
  "no_runtime",
  "unsupported",
  "malformed",
]);

function parseAckOutcome(outcome: Record<string, unknown>): AckOutcome | null {
  if (outcome.kind === "accepted") {
    return { kind: "accepted" };
  }
  if (
    outcome.kind === "rejected" &&
    typeof outcome.reason === "string" &&
    ACK_REJECTIONS.has(outcome.reason)
  ) {
    return { kind: "rejected", reason: outcome.reason as AckRejection };
  }
  return null;
}

export function isDeliverable(command: ProtocolCommand): command is DeliverableCommand {
  return DELIVERABLE_COMMAND_TYPES.has(command.type);
}
