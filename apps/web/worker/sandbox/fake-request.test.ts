import { describe, expect, it } from "vitest";
import type { FakeDriverSelection } from "./fake-request";
import { DEFAULT_FAKE_DRIVER, FAKE_DRIVER_MODEL, selectFakeDriver } from "./fake-request";

interface Case {
  readonly name: string;
  readonly raw: unknown;
  readonly env: string;
  readonly expected: FakeDriverSelection;
}

const CASES: readonly Case[] = [
  {
    name: "no fake key at all -> default",
    raw: {},
    env: "local",
    expected: { kind: "default" },
  },
  {
    name: "raw body is not a plain object (string) -> treated as absent -> default",
    raw: "not an object",
    env: "local",
    expected: { kind: "default" },
  },
  {
    name: "raw body is null -> treated as absent -> default",
    raw: null,
    env: "local",
    expected: { kind: "default" },
  },
  {
    name: "raw body is an array -> treated as absent -> default",
    raw: [],
    env: "local",
    expected: { kind: "default" },
  },
  {
    name: "fake present but env is hosted -> refused not_local, before the shape is even checked",
    raw: { fake: { scriptName: "seven-event", framePacingMs: 120 } },
    env: "hosted",
    expected: { kind: "refused", reason: "not_local" },
  },
  {
    name: "fake is not an object -> refused malformed",
    raw: { fake: "seven-event" },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "fake is null -> refused malformed",
    raw: { fake: null },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "fake is an empty object: scriptName missing -> refused malformed",
    raw: { fake: {} },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "scriptName is a number, not a string -> refused malformed",
    raw: { fake: { scriptName: 42, framePacingMs: 120 } },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "scriptName is a string loadBridgeScript does not know -> refused malformed",
    raw: { fake: { scriptName: "not-a-real-script", framePacingMs: 120 } },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "framePacingMs is not a number -> refused malformed",
    raw: { fake: { scriptName: "seven-event", framePacingMs: "fast" } },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "framePacingMs is not an integer -> refused malformed",
    raw: { fake: { scriptName: "long-stream", framePacingMs: 1.5 } },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "framePacingMs is negative -> refused malformed",
    raw: { fake: { scriptName: "stale-generation", framePacingMs: -1 } },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "framePacingMs is not below 10,000 -> refused malformed",
    raw: { fake: { scriptName: "sequence-gap", framePacingMs: 10_000 } },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "framePacingMs missing entirely -> refused malformed",
    raw: { fake: { scriptName: "seven-event" } },
    env: "local",
    expected: { kind: "refused", reason: "malformed" },
  },
  {
    name: "valid scriptName and null framePacingMs, local -> scripted",
    raw: { fake: { scriptName: "long-stream", framePacingMs: null } },
    env: "local",
    expected: {
      kind: "scripted",
      request: { scriptName: "long-stream", framePacingMs: null },
    },
  },
  {
    name: "valid scriptName and a valid framePacingMs, local -> scripted",
    raw: { fake: { scriptName: "seven-event", framePacingMs: 120 } },
    env: "local",
    expected: {
      kind: "scripted",
      request: { scriptName: "seven-event", framePacingMs: 120 },
    },
  },
];

describe("selectFakeDriver", () => {
  it.each(CASES)("$name", ({ raw, env, expected }) => {
    expect(selectFakeDriver(raw, env)).toEqual(expected);
  });
});

describe("DEFAULT_FAKE_DRIVER", () => {
  it("is seven-event paced at 120ms, so a viewer can see the deltas", () => {
    expect(DEFAULT_FAKE_DRIVER).toEqual({ scriptName: "seven-event", framePacingMs: 120 });
  });
});

describe("FAKE_DRIVER_MODEL", () => {
  it("satisfies the protocol's ModelRecord shape", () => {
    expect(FAKE_DRIVER_MODEL).toEqual({
      provider: "oncue-fake",
      modelId: "fake-driver",
      modelConnectionId: "placeholder",
      authenticationType: "api_key",
      contextWindow: null,
      effort: null,
    });
  });
});
