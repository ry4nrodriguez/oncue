import { describe, expect, it } from "vitest";
import { EVENT_CATALOG, EVENT_TYPES } from "../catalog";
import { COMMAND_TYPES, canIssueCommand } from "../commands";
import { PROTOCOL_VERSION } from "../envelope";
import { parseCommittedEvent, parseEvent } from "../events";
import {
  createStream,
  makeCommand,
  makeCommittedEvent,
  makeEvent,
  makeRedactedEvent,
  TEST_IDS,
  TEST_TIME,
  toJsonLine,
} from "./index";

describe("makeEvent", () => {
  it.each(EVENT_TYPES)("builds %s from defaults and it re-parses from its own origin", (type) => {
    const event = makeEvent(type);
    const spec = EVENT_CATALOG[type];
    expect(event.type).toBe(type);
    expect(event.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(event.runId).toBe(spec.scope === "run" ? TEST_IDS.runId : null);
    expect(event.runtimeSequence).toBe(spec.origin === "control" ? null : 0);
    const source = event.runtimeSequence === null ? "control" : "sandbox";
    expect(parseEvent(JSON.parse(toJsonLine(event)), source)).toEqual({ ok: true, value: event });
  });

  it("applies envelope and payload overrides", () => {
    const event = makeEvent("message.completed", {
      eventId: "evt_9",
      sessionId: "sess_9",
      sandboxGeneration: 4,
      runtimeSequence: 12,
      occurredAt: "2026-09-02T01:00:00.000Z",
      payload: { stopReason: "max_tokens", usage: null },
    });
    expect(event.eventId).toBe("evt_9");
    expect(event.sessionId).toBe("sess_9");
    expect(event.sandboxGeneration).toBe(4);
    expect(event.runtimeSequence).toBe(12);
    expect(event.occurredAt).toBe("2026-09-02T01:00:00.000Z");
    expect(event.payload.stopReason).toBe("max_tokens");
    expect(event.payload.usage).toBeNull();
    expect(event.payload.messageId).toBe("msg_1");
  });

  it("throws with the field name when an override breaks the schema", () => {
    expect(() =>
      makeEvent("message.completed", {
        payload: { stopReason: "banana" as "end_turn" },
      }),
    ).toThrow(/payload\.stopReason/);
  });

  it("throws when an override breaks an envelope rule", () => {
    expect(() => makeEvent("approval.resolved", { runtimeSequence: 3 as never })).toThrow(
      /unexpected_runtime_sequence/,
    );
  });
});

describe("makeCommittedEvent and makeRedactedEvent", () => {
  it("adds a commit stamp that the committed parser accepts", () => {
    const event = makeCommittedEvent("run.started", {}, { sessionSequence: 7 });
    expect(event.sessionSequence).toBe(7);
    expect(event.committedAt).toBe(TEST_TIME);
    expect(parseCommittedEvent(event)).toEqual({ ok: true, value: event });
  });

  it("returns the built event under the redacted brand", () => {
    const event = makeRedactedEvent("tool.completed");
    expect(event).toEqual(makeEvent("tool.completed"));
  });
});

describe("makeCommand", () => {
  it.each(COMMAND_TYPES)("builds %s with an issuable default expectation", (type) => {
    const command = makeCommand(type);
    expect(command.type).toBe(type);
    expect(command.commandId).toBe(TEST_IDS.commandId);
    expect(command.issuedByUserId).toBe(TEST_IDS.userId);
    expect(canIssueCommand(type, command.expected)).toBe(true);
  });

  it("gives a run-scoped command a runId and a session command null", () => {
    expect(makeCommand("run.pause").runId).toBe(TEST_IDS.runId);
    expect(makeCommand("run.start").runId).toBeNull();
  });

  it("rejects an expectation the command cannot be issued under", () => {
    expect(() =>
      makeCommand("run.pause", { expected: { scope: "run", state: "verified" } }),
    ).toThrow(/not issuable/);
  });

  it("rejects a payload override the schema refuses", () => {
    expect(() =>
      makeCommand("run.pause", { payload: { reason: "because" as "user_requested" } }),
    ).toThrow(/payload\.reason/);
  });

  it("rejects an invalid envelope field", () => {
    expect(() => makeCommand("run.pause", { issuedAt: "yesterday" as never })).toThrow(/issuedAt/);
  });
});

describe("createStream", () => {
  it("numbers sandbox events, leaves control events unnumbered, and restarts per generation", () => {
    const stream = createStream({ sessionId: "sess_s", runId: "run_s" });
    const provisioning = stream.emit("sandbox.provisioning");
    const connected = stream.emit("runtime.connected");
    const started = stream.emit("run.started");
    expect(provisioning.runtimeSequence).toBeNull();
    expect(connected.runtimeSequence).toBe(0);
    expect(started.runtimeSequence).toBe(1);
    expect(started.runId).toBe("run_s");
    expect(connected.runId).toBeNull();
    expect(stream.events.map((event) => event.eventId)).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(stream.events.every((event) => event.sessionId === "sess_s")).toBe(true);

    stream.replaceSandbox();
    const again = stream.emit("runtime.connected");
    expect(again.sandboxGeneration).toBe(2);
    expect(again.runtimeSequence).toBe(0);
    expect(stream.nextRuntimeSequence).toBe(1);
  });

  it("continues after an explicit sequence override", () => {
    const stream = createStream();
    stream.emit("runtime.connected");
    const skipped = stream.emit("runtime.ready", { runtimeSequence: 5 });
    expect(skipped.runtimeSequence).toBe(5);
    expect(stream.emit("run.started").runtimeSequence).toBe(6);
  });

  it("spaces occurredAt by the step", () => {
    const stream = createStream({ startAt: "2026-09-02T10:00:00.000Z", stepMs: 500 });
    stream.emit("runtime.connected");
    const second = stream.emit("runtime.ready");
    expect(second.occurredAt).toBe("2026-09-02T10:00:00.500Z");
  });
});
