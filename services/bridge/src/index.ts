export type {
  AttachedBridge,
  BridgeMessageEvent,
  BridgePacing,
  BridgeSocket,
} from "./fake-bridge";
export { attachFakeBridge } from "./fake-bridge";
// The three bridge frames only: no OpenCode, supervisor, or git types. See
// `frames.ts`.
export type {
  AckFrame,
  AckOutcome,
  AckRef,
  AckRejection,
  ApprovalFrame,
  ApprovalOutcome,
  AttachmentFetch,
  CommandFrame,
  DeliverableCommand,
  DeliverableCommandType,
  FrameIdentity,
  GitGrantFrame,
  GrantFrame,
  ModelGrantCatalogEntry,
  ModelGrantFrame,
  QuestionFrame,
  SessionFrame,
} from "./frames";
export {
  buildApprovalFrame,
  buildCommandFrame,
  buildGrantFrame,
  buildPolicyFrame,
  buildQuestionFrame,
  parseAckFrame,
} from "./frames";
// The pure half of the bridge's wire protocol, so the Worker's tests drive the
// real handshake and heartbeat framing against a live session object. Exported
// from `./protocol`, not `./main`, because `main.ts` touches `process.env` and
// `node:fs`, which do not type-check under the Worker's Node-free tsconfig.
export type {
  BridgeConfig,
  BridgeIdentity,
  BridgeIo,
  BridgeLink,
  HandshakeReview,
  HeartbeatFrame,
  HelloFrame,
  RefusalReason,
} from "./protocol";
export {
  bridgeConfig,
  bridgeConnectHeaders,
  bridgeConnectUrl,
  heartbeatFrame,
  helloFrame,
  reviewHandshakeReply,
  runLink,
  runtimeConnectedEvent,
} from "./protocol";
export type { QuestionOutcome } from "./questions";
export type {
  PromptCounts,
  PromptCountsReading,
  RelayConfig,
  RelayFailure,
  RelayForward,
  RelayPlan,
  RelayRefusal,
  RelayRequest,
  RelayTokenHolder,
} from "./relay";
export {
  brokerForwardPath,
  classifyUpstreamFailure,
  createRelayTokenHolder,
  PROMPT_COUNTS_HEADER,
  planRelayRequest,
  planRelayResponseHeaders,
  RELAY_HOST,
  RELAY_MESSAGES_PATH,
  readPromptCounts,
} from "./relay";
// The project file's reader, shared so the control plane reads a repository's
// declared secrets before launch with the same code the bridge uses after the
// clone. Pure: it takes the file's text.
export type { ProjectFile, ProjectFileSecrets, ProjectYamlResult } from "./repo-config";
export { MAX_DECLARED_SECRETS, PROJECT_FILE_PATH, readProjectYaml } from "./repo-config";
export type { BridgeScript, BridgeScriptContext, BridgeScriptName } from "./scripts";
export { loadBridgeScript } from "./scripts";
// The rules a development secret's name and value obey, shared so the control
// plane and the supervisor apply the same ones. Pure.
export type { SecretNameRefusal, SecretValueRefusal } from "./secret-names";
export {
  isSecretName,
  MAX_SECRET_VALUE_BYTES,
  MIN_SECRET_VALUE_CHARS,
  refuseSecretName,
  refuseSecretValue,
} from "./secret-names";
