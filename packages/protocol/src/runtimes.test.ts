import { describe, expect, it } from "vitest";
import { parseEvent } from "./events";
import {
  DEFAULT_RUNTIME_ID,
  isRuntimeId,
  MODEL_SWITCH_CAPABILITY,
  RUNTIME_CATALOG,
  RUNTIME_IDS,
  runtimeDescriptor,
} from "./runtimes";
import { EFFORT_LEVELS } from "./schema";
import { makeEvent } from "./testing";

describe("the runtime catalog", () => {
  it("describes every id under its own key, with levels and providers it can use", () => {
    for (const id of RUNTIME_IDS) {
      const descriptor = runtimeDescriptor(id);
      expect(descriptor.id).toBe(id);
      expect(RUNTIME_CATALOG[id]).toBe(descriptor);
      expect(descriptor.providers.length).toBeGreaterThan(0);
      expect(descriptor.effortLevels.every((level) => EFFORT_LEVELS.includes(level))).toBe(true);
    }
    expect(RUNTIME_IDS).toContain(DEFAULT_RUNTIME_ID);
  });

  it("says the image installs OpenCode and Codex alone, the default among them", () => {
    expect(RUNTIME_IDS.filter((id) => RUNTIME_CATALOG[id].inImage)).toEqual(["opencode", "codex"]);
    expect(RUNTIME_CATALOG[DEFAULT_RUNTIME_ID].inImage).toBe(true);
  });

  it("knows its ids and nothing else", () => {
    expect(isRuntimeId("opencode")).toBe(true);
    expect(isRuntimeId("codex")).toBe(true);
    expect(isRuntimeId("pi")).toBe(true);
    expect(isRuntimeId("claude")).toBe(true);
    expect(isRuntimeId("cursor")).toBe(false);
    expect(isRuntimeId(undefined)).toBe(false);
  });
});

describe("run.queued's runtime", () => {
  it("is optional, so a run stored before the adapter boundary still parses", () => {
    const stored = makeEvent("run.queued");
    expect("runtime" in stored.payload).toBe(false);
    expect(parseEvent(stored, "control").ok).toBe(true);
  });

  it("carries the harness and its pinned version, and refuses an id the catalog lacks", () => {
    const withRuntime = makeEvent("run.queued", {
      payload: { runtime: { id: "opencode", version: "1.18.30" } },
    });
    expect(withRuntime.payload.runtime).toEqual({ id: "opencode", version: "1.18.30" });
    const forged = {
      ...withRuntime,
      payload: { ...withRuntime.payload, runtime: { id: "cursor", version: "1" } },
    };
    expect(parseEvent(forged, "control").ok).toBe(false);
  });
});

describe("changing model in a live sandbox (record 15)", () => {
  it("is claimed only for OpenCode, the one harness it was observed on", () => {
    expect(RUNTIME_IDS.filter((id) => RUNTIME_CATALOG[id].liveModelSwitch)).toEqual(["opencode"]);
  });

  it("is a capability a bridge names on runtime.connected, and a run may be queued for it", () => {
    const connected = makeEvent("runtime.connected", {
      payload: { capabilities: [MODEL_SWITCH_CAPABILITY] },
    });
    expect(parseEvent(connected, "sandbox").ok).toBe(true);
    const changed = makeEvent("run.queued", {
      payload: { trigger: "model_change", continuesRunId: "run_0" },
    });
    expect(parseEvent(changed, "control").ok).toBe(true);
    expect(changed.payload.trigger).toBe("model_change");
  });
});
