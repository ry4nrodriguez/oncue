/**
 * The runtime-adapter boundary (record 04). A harness is the coding-agent
 * program that runs the model loop in the sandbox; its adapter has a pure half,
 * `RuntimePlan`, which the reducer in `agent.ts` calls, and an I/O half,
 * `RuntimeClient`, which `agent-io.ts` calls. Each client's parser produces
 * `RuntimeEvent`, so the reducer never sees a harness's wire.
 *
 * `profile` holds only facts shared code branches on; a flag nothing reads is
 * not added.
 */

import type { EffortLevel, PayloadOf, RuntimeId } from "@oncue/protocol";
import type { HealthOutcome, PromptOutcome, SpawnRequest } from "./agent";
import type { ClassifyContext, HarnessAsk } from "./ask-category";
import type { PromptFilePart } from "./attachments";
import type { ModelGrantCatalogEntry, ModelGrantSpec } from "./frames";
import type { RuntimeEvent } from "./normalize";
import type { ClassifiedAsk } from "./permissions";
import type { QuestionReply } from "./questions";

/** Every harness in `@oncue/protocol`'s catalog. The bridge has an adapter for each; the image installs only those marked `inImage`. */
export type { RuntimeId } from "@oncue/protocol";
export type { RuntimeEvent } from "./normalize";

export type ToolCategory = PayloadOf<"tool.requested">["category"];

/** The facts about a harness that shared code branches on. */
export interface RuntimeProfile {
  /** How the bridge drives it: a loopback HTTP server, JSON-RPC over the runtime host's socket, or an SDK in the bridge. */
  readonly control: "http" | "stdio-json-rpc" | "sdk";
  /** How OnCue's four tools reach it: its own channel where it has one, the loopback MCP server otherwise. */
  readonly toolDelivery: "loopback-mcp" | "sdk-in-process" | "rpc-dynamic" | "extension";
  /** A second prompt into a busy conversation is queued by the harness itself. */
  readonly steerIsOnePrompt: boolean;
  /** How a tool call is held for the user: the harness's own gate, or not at all. */
  readonly holdsToolCalls: "permission_gate" | "none";
  /** Accepts image content in a prompt. The composer hides attachments when false. */
  readonly images: boolean;
  /**
   * Whether the running process takes another model on its next prompt:
   * `per_prompt` where that was observed and the spawn configures every model
   * the grant lists, `none` where the process keeps the model it started on.
   */
  readonly modelSwitch: "per_prompt" | "none";
}

/** The run's model: the provider and the provider's own id. Each adapter names them in its harness's terms. */
export interface RuntimeModel {
  readonly provider: string;
  readonly modelId: string;
}

/** Everything `planSpawn` needs, harness-neutral. Every override is the dev host's. */
export interface RuntimeSpawnOptions {
  readonly port: number;
  readonly relayPort: number;
  readonly toolPort: number;
  readonly model: RuntimeModel;
  /** What the Worker's catalog knows about the model, from the grant; `null` for a model it does not list. */
  readonly modelSpec: ModelGrantSpec | null;
  /** The other models the session may change to (the grant's `catalog`); read only by a `per_prompt` harness. */
  readonly catalog?: readonly ModelGrantCatalogEntry[] | undefined;
  /** Overrides the sandbox's binary path for the dev host; the supervisor still enforces its own allowlist. */
  readonly binary?: string | undefined;
  /** Overrides the sandbox's `/workspace`. The dev host has no second Unix user, so this is a plain directory. */
  readonly cwd?: string | undefined;
  /** Overrides the sandbox agent's home. Drives `HOME` and every `XDG_*` variable. */
  readonly home?: string | undefined;
  /** Overrides where the supervisor writes development secrets (`SECRETS_DIR` on the image). The dev host keeps them beside the work tree. */
  readonly secretsDir?: string | undefined;
  /** Overrides where attachments are placed (`ATTACHMENTS_ROOT` on the image). */
  readonly attachmentsDir?: string | undefined;
  /** Overrides the image's Node and runtime host, for a harness that runs under the host. The dev host's own. */
  readonly hostPaths?: { readonly node: string; readonly host: string } | undefined;
  /** Overrides the directory a harness's helpers are found in, put first on its `PATH`. */
  readonly pathPrefix?: string | undefined;
  /** Overrides where OnCue's extension for a harness that loads one is found (Pi's). The dev host's build output. */
  readonly extensionPath?: string | undefined;
}

/** One prompt into the harness. The resume context, when there is one, is already prepended to `text`. */
export interface PromptTurn {
  /** The harness's own conversation id, opaque to the reducer; null starts one. */
  readonly conversation: string | null;
  readonly title: string;
  readonly text: string;
  readonly model: RuntimeModel;
  /** The run's recorded effort; `null` sends none. The Model Broker enforces it on every request. */
  readonly effort: EffortLevel | null;
  /**
   * Image attachments the harness passes to the model, as `file://` parts under
   * the attachments root. The note naming every attachment is already in `text`.
   */
  readonly files?: readonly PromptFilePart[] | undefined;
}

/** The pure half: constants and pure functions the reducer calls. One value per harness. */
export interface RuntimePlan {
  readonly id: RuntimeId;
  /** The version the image carries; `runtime.ready` reports the one the harness itself said. */
  readonly pinnedVersion: string;
  /** Providers this harness can drive through the relay. */
  readonly providers: readonly string[];
  /** The loopback port the harness (or its runtime host) serves on in the sandbox. */
  readonly defaultPort: number;
  readonly profile: RuntimeProfile;
  /** argv, cwd, and the complete environment, as the supervisor will check them. */
  planSpawn(options: RuntimeSpawnOptions): SpawnRequest;
  /** The harness's own tool name -> protocol category. Unlisted is "other". */
  toolCategory(tool: string): ToolCategory;
  /** The name the model sees for one of OnCue's tools, which is also the key its permission gate uses. */
  presentToolName(oncueName: string): string;
  /** One of its permission asks in OnCue's categories (record 09). Anything unrecognised is `other_request`. */
  classifyAsk(ask: HarnessAsk, ctx: ClassifyContext): ClassifiedAsk;
  /**
   * Whether rejecting one ask also rejects every other pending ask of the
   * session (OpenCode's does), so the bridge forwards none of them.
   */
  readonly rejectSettlesOtherAsks: boolean;
  /**
   * The conversation size at which the harness compacts on its own, for a
   * harness whose rule was read from its source; absent where it was not.
   */
  autoCompactAt?(spec: { readonly contextWindow: number; readonly maxOutput: number }): number;
}

/** The two facts of a harness that decide which models one process can be prompted with. */
export interface SwitchFacts {
  readonly providers: readonly string[];
  readonly profile: Pick<RuntimeProfile, "modelSwitch">;
}

/**
 * Every model the process a spawn starts can be prompted with: the one it
 * starts on and, for a `per_prompt` harness, each catalog model of a provider
 * it drives. The reducer refuses a model grant outside this list once the
 * process is up, and the adapter's spawn configures exactly this list.
 */
export function promptableModels(
  plan: SwitchFacts,
  model: RuntimeModel,
  catalog: readonly ModelGrantCatalogEntry[] | undefined,
): readonly RuntimeModel[] {
  return [
    model,
    ...switchableEntries(plan, model, catalog).map(({ provider, modelId }) => ({
      provider,
      modelId,
    })),
  ];
}

/** The catalog entries a `per_prompt` harness is configured for besides the model it starts on. */
export function switchableEntries(
  plan: SwitchFacts,
  model: RuntimeModel,
  catalog: readonly ModelGrantCatalogEntry[] | undefined,
): readonly ModelGrantCatalogEntry[] {
  if (plan.profile.modelSwitch !== "per_prompt" || catalog === undefined) {
    return [];
  }
  return catalog.filter(
    (entry) =>
      plan.providers.includes(entry.provider) &&
      !(entry.provider === model.provider && entry.modelId === model.modelId),
  );
}

/** The I/O half, called by the interpreter. */
export interface RuntimeClient {
  /** The harness answering. A refused connection is `not_yet`, not a throw. */
  health(port: number): Promise<HealthOutcome>;
  /** Start or continue a conversation. Resolves when the harness accepted the prompt, not when the turn ends. */
  prompt(port: number, turn: PromptTurn): Promise<PromptOutcome>;
  /** End the turn and leave the harness running. */
  abort(port: number, conversation: string): Promise<boolean>;
  /** Answer a held tool call. Never "always", which would save a rule. True is not evidence the call ran. */
  replyHeld(
    port: number,
    requestId: string,
    reply: "once" | "reject",
    message: string | null,
  ): Promise<boolean>;
  /**
   * Answer or dismiss a question the harness is waiting on (`question_asked`).
   * Answers are one list per question, in order: chosen labels or typed text.
   * True means the harness took the reply, not that the model has read it.
   */
  replyQuestion(port: number, requestId: string, reply: QuestionReply): Promise<boolean>;
  /**
   * The questions the harness is waiting on now, as `question_asked` events,
   * for a harness that keeps them across a gap in its event stream: one asked
   * while the stream was down is offered again once it reconnects. Absent
   * where a question cannot outlive the stream that announced it.
   */
  pendingQuestions?(port: number): Promise<RuntimeEvent[]>;
  /**
   * One long-lived subscription; every wire message becomes a `RuntimeEvent`,
   * unknown ones included. Resolves when it ends, however it ends. A client
   * that reads a stream awaits `room` before each read, so the bridge stops
   * taking events in while its unsent events are over their bound.
   */
  subscribe(
    port: number,
    onEvent: (event: RuntimeEvent) => void,
    signal: AbortSignal,
    log?: (line: string) => void,
    room?: () => Promise<void>,
  ): Promise<void>;
}
