import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  liveModelConnectionId,
  readModelChoice,
  useModelChoice,
  writeModelChoice,
} from "./model-choice";

afterEach(() => {
  window.localStorage.clear();
});

describe("the remembered model choice", () => {
  it("remembers a choice per workspace and reads it back", () => {
    writeModelChoice("ws_1", { connectionId: "mc_1", modelId: "claude-opus-5-5" });
    expect(readModelChoice("ws_1")).toEqual({ connectionId: "mc_1", modelId: "claude-opus-5-5" });
    expect(readModelChoice("ws_2")).toBeNull();
    expect(readModelChoice(null)).toBeNull();
  });

  it("ignores a hand-edited or blocked value", () => {
    window.localStorage.setItem("oncue.model.ws_1", "not json");
    expect(readModelChoice("ws_1")).toBeNull();
    window.localStorage.setItem("oncue.model.ws_1", JSON.stringify({ connectionId: 3 }));
    expect(readModelChoice("ws_1")).toBeNull();
  });

  it("chooses through the hook and keeps it for the next visit", () => {
    const { result } = renderHook(() => useModelChoice("ws_1"));
    expect(result.current.choice).toBeNull();
    act(() => result.current.choose("mc_1", "gpt-6-sol"));
    expect(result.current.choice).toEqual({ connectionId: "mc_1", modelId: "gpt-6-sol" });
    expect(readModelChoice("ws_1")).toEqual({ connectionId: "mc_1", modelId: "gpt-6-sol" });
    // No workspace: the choice is held for the screen but written nowhere.
    const { result: nowhere } = renderHook(() => useModelChoice(null));
    act(() => nowhere.current.choose("mc_1", "gpt-6-luna"));
    expect(nowhere.current.choice?.modelId).toBe("gpt-6-luna");
    expect(readModelChoice("ws_1")?.modelId).toBe("gpt-6-sol");
  });
});

describe("the connection the composer sends", () => {
  // Newest first, as the Worker lists them.
  const listed = [{ modelConnectionId: "mc_new" }, { modelConnectionId: "mc_old" }];

  it("is what was picked on this page, before what was remembered", () => {
    expect(liveModelConnectionId(listed, "mc_new", "mc_old")).toBe("mc_new");
  });

  it("is the remembered one when nothing was picked", () => {
    expect(liveModelConnectionId(listed, null, "mc_new")).toBe("mc_new");
  });

  it("is the oldest key when nothing was picked or remembered", () => {
    expect(liveModelConnectionId(listed, null, null)).toBe("mc_old");
  });

  it("passes over a pick and a memory the list no longer holds, so a revoked key is never sent", () => {
    expect(liveModelConnectionId(listed, "mc_revoked", "mc_new")).toBe("mc_new");
    expect(liveModelConnectionId(listed, "mc_revoked", "mc_also_revoked")).toBe("mc_old");
    expect(liveModelConnectionId([{ modelConnectionId: "mc_only" }], "mc_revoked", null)).toBe(
      "mc_only",
    );
  });

  it("is nothing when the workspace has no key", () => {
    expect(liveModelConnectionId([], "mc_revoked", "mc_revoked")).toBeUndefined();
  });
});
