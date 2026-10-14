import type { GenericSchema } from "./schema";

// Record 04's fourteen headings. Family membership is declared per module, never
// derived from the type prefix: record 04 groups `message.queued` and
// `sandbox.keepalive.updated` under "Policy and commands".
export const EVENT_FAMILIES = [
  "lifecycle",
  "messages",
  "plans",
  "tools",
  "files",
  "git",
  "policy",
  "sandbox",
  "review",
  "verification",
  "approvals",
  "questions",
  "artifacts",
  "agents",
] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

export const EVENT_FAMILY_HEADINGS: { readonly [F in EventFamily]: string } = {
  lifecycle: "Lifecycle",
  messages: "Messages and reasoning summaries",
  plans: "Plans",
  tools: "Tools",
  files: "Files and repository state",
  git: "Git and pull requests",
  policy: "Policy and commands",
  sandbox: "Sandbox lifecycle",
  review: "Pull-request feedback",
  verification: "Verification",
  approvals: "Approvals",
  questions: "Questions",
  artifacts: "Artifacts",
  agents: "Subagents",
};

export type EventScope = "run" | "session";

// "sandbox" arrives over the bridge connection and carries a runtimeSequence.
// "control" is minted by the Durable Object or Worker with runtimeSequence null.
// "either" is for the few events both sides legitimately emit.
export type EventOrigin = "sandbox" | "control" | "either";

// Record 04: ephemeral events may be broadcast live and dropped; they never
// receive a session sequence.
export type Durability = "durable" | "ephemeral";

export type EventSpecInput = {
  readonly scope: EventScope;
  readonly origin: EventOrigin;
  readonly durability: Durability;
  readonly payload: GenericSchema;
};

export type EventSpec = EventSpecInput & { readonly family: EventFamily };

export function defineFamily<
  const F extends EventFamily,
  const E extends Record<string, EventSpecInput>,
>(family: F, entries: E): { readonly [K in keyof E]: E[K] & { readonly family: F } } {
  const out: Record<string, EventSpec> = {};
  for (const [type, spec] of Object.entries(entries)) {
    out[type] = { ...spec, family };
  }
  return out as { readonly [K in keyof E]: E[K] & { readonly family: F } };
}
