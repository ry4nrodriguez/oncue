/**
 * The harnesses the bridge has runtime adapters for: the coding-agent programs
 * that run the model loop. Shared by the bridge, the session object, and the
 * browser so they agree on which harnesses exist and what each can drive.
 * Having an adapter is not offering it: a harness runs only when `inImage` says
 * the sandbox image installs it and `ONCUE_RUNTIME_ALLOWLIST` names it (OpenCode
 * alone when unset), both checked in `apps/web/worker/runtime/resolve.ts`.
 */

import type { EffortLevel } from "./schema";

export const RUNTIME_IDS = ["opencode", "codex", "pi", "claude"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

/** What a stored run that names no runtime reads as. */
export const DEFAULT_RUNTIME_ID: RuntimeId = "opencode";

export interface RuntimeDescriptor {
  readonly id: RuntimeId;
  /** Plain words, never a vendor's mark as a product name. */
  readonly name: string;
  /** The version the image pins; `runtime.ready` reports the one the harness itself said. */
  readonly pinnedVersion: string;
  /**
   * Whether the sandbox image installs this harness's binary. OpenCode is in
   * the image's base layer and every other installed harness has a row in
   * `HARNESS_LAYERS` (`services/sandbox-controller/images.py`);
   * `test_images.py` fails when the two disagree. A harness without it is
   * refused whatever the allowlist names, because its spawn could only fail.
   */
  readonly inImage: boolean;
  /** Providers the harness can drive through the Model Broker's relay. */
  readonly providers: readonly string[];
  /** The effort levels the harness can send; the broker enforces the run's own on every request. */
  readonly effortLevels: readonly EffortLevel[];
  /** Accepts image content in a prompt. The composer hides attachments when false. */
  readonly images: boolean;
  /** Can hold one tool call for the user, which a mid-run secret request needs. */
  readonly holdsToolCalls: boolean;
  /**
   * Whether a running harness takes another model on its next prompt, so a
   * session can change model without a new sandbox (record 15). True only
   * where that was observed; false sends the change to a new generation.
   */
  readonly liveModelSwitch: boolean;
}

export const RUNTIME_CATALOG: {
  readonly [Id in RuntimeId]: RuntimeDescriptor & { readonly id: Id };
} = {
  opencode: {
    id: "opencode",
    name: "OpenCode",
    pinnedVersion: "1.18.30",
    inImage: true,
    providers: ["anthropic", "openai"],
    // A prompt names any level as its `variant`.
    effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    images: true,
    holdsToolCalls: true,
    // A prompt names its model, and the bridge points every catalog provider
    // at the relay when it starts OpenCode.
    liveModelSwitch: true,
  },
  codex: {
    id: "codex",
    name: "Codex",
    pinnedVersion: "0.157.1",
    inImage: true,
    // Codex speaks only the Responses API; Claude through Codex would need
    // the broker to translate it, which it does not.
    providers: ["openai"],
    // `turn/start`'s `effort`, in OpenAI's words.
    effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    // `localImage` input.
    images: true,
    // The bridge answers a dynamic tool call when it is ready, so it can hold one.
    holdsToolCalls: true,
    liveModelSwitch: false,
  },
  pi: {
    id: "pi",
    name: "Pi",
    pinnedVersion: "0.87.1",
    inImage: false,
    // `anthropic-messages` and `openai-responses`, both through the relay.
    providers: ["anthropic", "openai"],
    // Pi's thinking levels, with OnCue's `none` as Pi's `off`. Pi clamps a
    // level the model cannot take (`set_thinking_level`).
    effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    // A prompt's `images`.
    images: true,
    // OnCue's extension holds the call in Pi's `tool_call` handler until the bridge answers.
    holdsToolCalls: true,
    liveModelSwitch: false,
  },
  claude: {
    id: "claude",
    name: "Claude Code",
    // The Claude Code that Agent SDK 0.3.283 carries.
    pinnedVersion: "2.1.283",
    inImage: false,
    // Anthropic's Messages API only.
    providers: ["anthropic"],
    // Claude Code's own levels. It is started sending none, and the Model
    // Broker writes the run's into every request.
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    // Image blocks in a user message.
    images: true,
    // Its permission prompts come to the bridge (`can_use_tool`), which answers when ready.
    holdsToolCalls: true,
    liveModelSwitch: false,
  },
};

/**
 * A bridge capability, named on `runtime.connected`: the bridge starts a
 * harness configured for every model its model grant lists, and refuses a
 * grant for a model the running harness was not configured for. The session
 * object changes model in a live sandbox only for a bridge that says so and a
 * harness with `liveModelSwitch` (record 15).
 */
export const MODEL_SWITCH_CAPABILITY = "model_switch";

export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && (RUNTIME_IDS as readonly string[]).includes(value);
}

export function runtimeDescriptor(id: RuntimeId): RuntimeDescriptor {
  return RUNTIME_CATALOG[id];
}
