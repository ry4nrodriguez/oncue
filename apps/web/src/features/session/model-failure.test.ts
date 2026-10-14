import { MODEL_FAILURE_CATEGORIES, type RunView } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import {
  KEY_GUIDANCE,
  type ModelFailure,
  modelFailureNote,
  modelFailureNoteText,
  modelFailureSentence,
  pausedModelFailureOf,
  runConnectionStateOf,
} from "./model-failure";

// The message is what the bridge really sends: a diagnostic, not a sentence for the person.
const REJECTED: ModelFailure = {
  category: "authentication_failed",
  message: "broker answered 403: The provider rejected this connection's credential.",
  retries: 0,
};
const REJECTED_SENTENCE = "Model request failed: the provider rejected the model key.";

function pause(payload: Record<string, unknown>): RunView["pause"] {
  return makeCommittedEvent("run.paused", { payload }).payload;
}

describe("runConnectionStateOf", () => {
  const active = [{ modelConnectionId: "mc_good" }];
  const inactive = [{ modelConnectionId: "mc_bad" }];

  it.each([
    ["an active key", "mc_good", "active"],
    ["a key that stopped working", "mc_bad", "replaceable"],
    ["a connection in neither list, revoked or deleted", "mc_revoked", "gone"],
    ["no model record yet", null, "active"],
  ] as const)("reads %s", (_name, connectionId, expected) => {
    expect(runConnectionStateOf(connectionId, active, inactive)).toBe(expected);
  });
});

describe("pausedModelFailureOf", () => {
  const failed = pause({ reason: "model_failure", modelFailure: REJECTED });

  it("names the failure while the run is paused on it", () => {
    expect(pausedModelFailureOf({ state: "paused", pause: failed })).toEqual(REJECTED);
  });

  // A run keeps its last pause after it resumes; that pause is no longer what it waits on.
  it.each(["provisioning", "running", "verified", "cancelled"] as const)(
    "names nothing once the run is %s again",
    (state) => {
      expect(pausedModelFailureOf({ state, pause: failed })).toBeNull();
    },
  );

  it("names nothing for another pause, a pause with no failure on it, or no run", () => {
    expect(
      pausedModelFailureOf({ state: "paused", pause: pause({ reason: "user_requested" }) }),
    ).toBeNull();
    expect(
      pausedModelFailureOf({ state: "paused", pause: pause({ reason: "model_failure" }) }),
    ).toBeNull();
    expect(pausedModelFailureOf({ state: "paused", pause: null })).toBeNull();
    expect(pausedModelFailureOf(null)).toBeNull();
  });
});

describe("modelFailureSentence", () => {
  it("says the category in plain words", () => {
    expect(modelFailureSentence(REJECTED)).toBe(REJECTED_SENTENCE);
  });

  it("leaves the bridge's diagnostic out", () => {
    expect(modelFailureSentence(REJECTED)).not.toContain("broker answered");
    expect(modelFailureSentence({ ...REJECTED, message: "" })).toBe(REJECTED_SENTENCE);
  });

  it("never falls back to a category's wire spelling", () => {
    for (const category of MODEL_FAILURE_CATEGORIES) {
      expect(modelFailureSentence({ category, message: category, retries: 0 })).not.toContain(
        category,
      );
    }
  });
});

describe("modelFailureNote, for a rejected key", () => {
  const note = (
    sandboxLive: boolean,
    connection: Parameters<typeof modelFailureNote>[0]["connection"],
  ) => modelFailureNote({ failure: REJECTED, sandboxLive, connection });

  // A rejected key's sandbox can stop seconds after the pause, or be kept alive
  // for an hour; the note is the same sentence throughout.
  it.each([true, false])(
    "says to replace the key, then continue, the same way whether the sandbox is running (%s)",
    (sandboxLive) => {
      expect(note(sandboxLive, "replaceable")).toEqual(note(false, "replaceable"));
    },
  );

  it("says to replace the key, then continue", () => {
    expect(note(false, "replaceable")).toEqual({
      failure: REJECTED_SENTENCE,
      next: "Replace the key under Settings, Model providers, then come back here to continue the run.",
      linksToKeys: true,
    });
  });

  // Active after a rejection means replaced since, or a refusal that never
  // marked the key; the note reads right for both and still links to the keys.
  it("says to continue once the key is active and the sandbox has stopped, without claiming it was replaced", () => {
    expect(note(false, "active")).toEqual({
      failure: REJECTED_SENTENCE,
      next: "The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it. Send a message to continue the run from its last checkpoint.",
      linksToKeys: true,
    });
    expect(modelFailureNoteText(note(false, "active"))).not.toContain("replaced");
  });

  it("says a message cannot reach the run yet when the key is active again and the sandbox still runs", () => {
    expect(note(true, "active")).toEqual({
      failure: REJECTED_SENTENCE,
      next: "The key is listed as active under Settings, Model providers. Replace it there if the provider still rejects it. A message can't reach the run while its sandbox is still running. Stop the run to send a new message from here, or wait: once the sandbox stops, the run can continue from its last checkpoint.",
      linksToKeys: true,
    });
  });

  // Only a revoked or deleted connection sends the work to a new session.
  it.each([true, false])(
    "sends the work to a new session when the connection is gone (sandbox running: %s)",
    (sandboxLive) => {
      const gone = note(sandboxLive, "gone");
      expect(gone.next).toBe(
        "The key this run used has since been removed. Add a working key under Settings, Model providers, then start a new session to continue the work.",
      );
      expect(gone.linksToKeys).toBe(true);
    },
  );

  it("never mentions a new session while the key can be replaced or is active", () => {
    for (const sandboxLive of [true, false]) {
      for (const connection of ["active", "replaceable"] as const) {
        expect(modelFailureNoteText(note(sandboxLive, connection))).not.toContain("new session");
      }
    }
  });

  it("names the failure alone, with the link, until the key's state has been read", () => {
    expect(note(true, null)).toEqual({ failure: REJECTED_SENTENCE, next: null, linksToKeys: true });
    expect(modelFailureNoteText(note(true, null))).toBe(REJECTED_SENTENCE);
  });
});

describe("modelFailureNote, for a failure that leaves the key alone", () => {
  const limit: ModelFailure = {
    category: "usage_limit_reached",
    message: "This connection has reached a limit with the provider.",
    retries: 0,
  };

  it("does not claim the key was replaced, and does not link to the keys", () => {
    const stopped = modelFailureNote({ failure: limit, sandboxLive: false, connection: "active" });
    expect(modelFailureNoteText(stopped)).toBe(
      "Model request failed: this key has reached its usage limit. Send a message to continue the run from its last checkpoint.",
    );
    expect(stopped.linksToKeys).toBe(false);
    const running = modelFailureNote({ failure: limit, sandboxLive: true, connection: "active" });
    expect(running.next).toMatch(/^A message can't reach the run/);
    expect(
      modelFailureNote({ failure: limit, sandboxLive: true, connection: null }).linksToKeys,
    ).toBe(false);
  });

  it("still says to replace a key that has stopped working since", () => {
    const note = modelFailureNote({
      failure: limit,
      sandboxLive: false,
      connection: "replaceable",
    });
    expect(note.next).toContain("Replace the key");
    expect(note.linksToKeys).toBe(true);
  });
});

describe("KEY_GUIDANCE", () => {
  it("sends only a removed key's session to a new session", () => {
    expect(KEY_GUIDANCE.replaceable).toBe(
      "The model key for this session has stopped working. Replace it under Settings, Model providers, then come back here to continue.",
    );
    expect(KEY_GUIDANCE.gone).toBe(
      "The model key for this session was removed. Add a working key under Settings, Model providers, then start a new session to continue the work.",
    );
  });
});
