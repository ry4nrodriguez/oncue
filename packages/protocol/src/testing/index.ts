import { type DurableEventType, EVENT_CATALOG, type EventType } from "../catalog";
import {
  COMMAND_CATALOG,
  type CommandCatalog,
  type CommandOf,
  type CommandType,
  canIssueCommand,
  parseCommandPayload,
} from "../commands";
import { PROTOCOL_VERSION } from "../envelope";
import {
  type BuildInput,
  buildEvent,
  type CommittedEventOf,
  type PayloadInputOf,
  type ProtocolEvent,
  type ProtocolEventOf,
  parseCommittedEvent,
} from "../events";
import { assumeRedacted, type Redacted } from "../redact";
import {
  commandId,
  type InferInput,
  nullable,
  runId,
  safeParse,
  sessionId,
  strictObject,
  timestamp,
  toFailure,
  userId,
} from "../schema";
import { COMMAND_PAYLOAD_DEFAULTS, PAYLOAD_DEFAULTS } from "./defaults";

export { COMMAND_PAYLOAD_DEFAULTS, PAYLOAD_DEFAULTS } from "./defaults";
export * from "./values";

export const TEST_IDS = {
  eventId: "evt_1",
  sessionId: "sess_1",
  runId: "run_1",
  commandId: "cmd_1",
  userId: "user_1",
} as const;

export const TEST_TIME = "2026-09-02T00:00:00.000Z";

export type EventOverrides<T extends EventType> = Partial<Omit<BuildInput<T>, "payload">> & {
  readonly payload?: Partial<PayloadInputOf<T>>;
};

// Every builder goes through `buildEvent`, which runs the real parser, so a
// schema change that invalidates a default fails here with a named field.
export function makeEvent<T extends EventType>(
  type: T,
  overrides: EventOverrides<T> = {},
): ProtocolEventOf<T> {
  const spec = EVENT_CATALOG[type];
  const input = {
    eventId: overrides.eventId ?? TEST_IDS.eventId,
    sessionId: overrides.sessionId ?? TEST_IDS.sessionId,
    runId:
      overrides.runId !== undefined
        ? overrides.runId
        : spec.scope === "run"
          ? TEST_IDS.runId
          : null,
    sandboxGeneration: overrides.sandboxGeneration ?? 1,
    runtimeSequence:
      overrides.runtimeSequence !== undefined
        ? overrides.runtimeSequence
        : spec.origin === "control"
          ? null
          : 0,
    occurredAt: overrides.occurredAt ?? TEST_TIME,
    payload: { ...PAYLOAD_DEFAULTS[type](), ...overrides.payload },
  } as unknown as BuildInput<T>;
  return buildEvent(type, input);
}

export type CommitOverrides = {
  readonly sessionSequence?: number;
  readonly committedAt?: string;
};

export function makeCommittedEvent<T extends DurableEventType>(
  type: T,
  overrides: EventOverrides<T> = {},
  commit: CommitOverrides = {},
): CommittedEventOf<T> {
  const event = makeEvent(type, overrides);
  const result = parseCommittedEvent({
    ...event,
    sessionSequence: commit.sessionSequence ?? 0,
    committedAt: commit.committedAt ?? event.occurredAt,
  });
  if (!result.ok) {
    throw new Error(`makeCommittedEvent(${type}) rejected: ${result.reason} ${result.detail}`);
  }
  return result.value as CommittedEventOf<T>;
}

export function makeRedactedEvent<T extends EventType>(
  type: T,
  overrides: EventOverrides<T> = {},
): Redacted<ProtocolEventOf<T>> {
  return assumeRedacted(makeEvent(type, overrides), "test");
}

export type CommandPayloadInputOf<T extends CommandType> = InferInput<CommandCatalog[T]["payload"]>;

export type CommandOverrides<T extends CommandType> = Partial<
  Omit<CommandOf<T>, "type" | "payload" | "expected">
> & {
  readonly expected?: CommandOf<T>["expected"];
  readonly payload?: Partial<CommandPayloadInputOf<T>>;
};

const commandFields = strictObject({
  commandId,
  sessionId,
  runId: nullable(runId),
  issuedAt: timestamp,
  issuedByUserId: userId,
});

function defaultExpectation(type: CommandType): ProtocolCommandExpectation {
  const spec = COMMAND_CATALOG[type];
  if (spec.scope === "run") {
    const state = spec.allowedRunStates[0];
    if (state === undefined) {
      throw new Error(`makeCommand(${type}): no allowed run state`);
    }
    return { scope: "run", state };
  }
  const state = spec.allowedSessionStates[0];
  if (state === undefined) {
    throw new Error(`makeCommand(${type}): no allowed session state`);
  }
  return { scope: "session", state };
}

type ProtocolCommandExpectation = CommandOf<CommandType>["expected"];

export function makeCommand<T extends CommandType>(
  type: T,
  overrides: CommandOverrides<T> = {},
): CommandOf<T> {
  const spec = COMMAND_CATALOG[type];
  const fields = safeParse(commandFields, {
    commandId: overrides.commandId ?? TEST_IDS.commandId,
    sessionId: overrides.sessionId ?? TEST_IDS.sessionId,
    runId:
      overrides.runId !== undefined
        ? overrides.runId
        : spec.scope === "run"
          ? TEST_IDS.runId
          : null,
    issuedAt: overrides.issuedAt ?? TEST_TIME,
    issuedByUserId: overrides.issuedByUserId ?? TEST_IDS.userId,
  });
  if (!fields.success) {
    const failure = toFailure("envelope", fields.issues);
    throw new Error(`makeCommand(${type}) rejected: ${failure.reason} ${failure.detail}`);
  }
  if (spec.scope === "run" && fields.output.runId === null) {
    throw new Error(`makeCommand(${type}) rejected: runId is required for a run-scoped command`);
  }
  if (spec.scope === "session" && fields.output.runId !== null) {
    throw new Error(`makeCommand(${type}) rejected: runId must be null for a session command`);
  }
  const expected = overrides.expected ?? defaultExpectation(type);
  if (!canIssueCommand(type, expected)) {
    throw new Error(
      `makeCommand(${type}) rejected: not issuable when ${expected.scope} is ${expected.state}`,
    );
  }
  const payload = parseCommandPayload(type, {
    ...COMMAND_PAYLOAD_DEFAULTS[type](),
    ...overrides.payload,
  });
  if (!payload.ok) {
    throw new Error(`makeCommand(${type}) rejected: ${payload.reason} ${payload.detail}`);
  }
  return {
    ...fields.output,
    expected,
    type,
    payload: payload.value,
  } as unknown as CommandOf<T>;
}

export type StreamOptions = {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly sandboxGeneration?: number;
  readonly startAt?: string;
  readonly stepMs?: number;
  readonly eventIdPrefix?: string;
};

export type StreamEmitOverrides<T extends EventType> = Omit<EventOverrides<T>, "sessionId">;

export interface EventStream {
  readonly events: readonly ProtocolEvent[];
  readonly sessionId: string;
  readonly sandboxGeneration: number;
  readonly nextRuntimeSequence: number;
  emit<T extends EventType>(type: T, overrides?: StreamEmitOverrides<T>): ProtocolEventOf<T>;
  // A new generation restarts the bridge's sequence at zero (record 11).
  replaceSandbox(generation?: number): void;
}

// Numbers events the way the bridge and Durable Object would: sandbox-origin
// events take the next runtime sequence, control-origin events carry null,
// and eventId, occurredAt, and runId are filled in unless overridden.
export function createStream(options: StreamOptions = {}): EventStream {
  const events: ProtocolEvent[] = [];
  const sessionIdValue = options.sessionId ?? TEST_IDS.sessionId;
  const runIdValue = options.runId ?? TEST_IDS.runId;
  const startMs = Date.parse(options.startAt ?? TEST_TIME);
  const stepMs = options.stepMs ?? 1000;
  const prefix = options.eventIdPrefix ?? "evt_";
  let generation = options.sandboxGeneration ?? 1;
  let nextSequence = 0;

  const stream: EventStream = {
    events,
    sessionId: sessionIdValue,
    get sandboxGeneration() {
      return generation;
    },
    get nextRuntimeSequence() {
      return nextSequence;
    },
    emit<T extends EventType>(type: T, overrides: StreamEmitOverrides<T> = {}): ProtocolEventOf<T> {
      const spec = EVENT_CATALOG[type];
      const index = events.length;
      let runtimeSequence: number | null;
      if (overrides.runtimeSequence !== undefined) {
        runtimeSequence = overrides.runtimeSequence;
      } else if (spec.origin === "control") {
        runtimeSequence = null;
      } else {
        runtimeSequence = nextSequence;
      }
      if (runtimeSequence !== null) {
        nextSequence = runtimeSequence + 1;
      }
      const event = makeEvent(type, {
        eventId: `${prefix}${index + 1}`,
        runId: spec.scope === "run" ? runIdValue : null,
        sandboxGeneration: generation,
        occurredAt: new Date(startMs + index * stepMs).toISOString(),
        ...overrides,
        sessionId: sessionIdValue,
        runtimeSequence,
      } as EventOverrides<T>);
      events.push(event);
      return event;
    },
    replaceSandbox(next = generation + 1) {
      generation = next;
      nextSequence = 0;
    },
  };
  return stream;
}

export function toJsonLine(event: ProtocolEvent | Record<string, unknown>): string {
  return JSON.stringify(event);
}

export { PROTOCOL_VERSION };
