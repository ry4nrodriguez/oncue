import { describe, expect, it } from "vitest";
import { DEADLINE_GRACE_MS } from "./permissions";
import {
  hasUnsentRequest,
  INITIAL_SECRETS,
  onApprovalDeadline,
  onApprovalFrame,
  onPermissionAsked,
  onRequestSettled,
  onRunEnded,
  onSecretGrant,
  onSecretsWritten,
  onShutdown,
  onToolPart,
  pump,
  SECRET_TOOL_NAME,
  type SecretsState,
  secretPermissionKey,
  secretToolAnswer,
} from "./secrets";

const KEY = secretPermissionKey("oncue");
const FAKE_VALUE = "fake-stripe-test-key-0001";
const ASKED = { requestId: "per_1", permission: KEY, callId: "call_1" };
const CTX = { permissionKey: KEY, runActive: true, newRef: () => "ref_1" };
const pathOf = (name: string) => `/var/lib/oncue/secrets/${name}`;

function waitingFor(name = "STRIPE_TEST_KEY"): SecretsState {
  const asked = onPermissionAsked(INITIAL_SECRETS, ASKED, CTX).state;
  return onToolPart(asked, { callId: "call_1", status: "running", input: { name } }).state;
}

describe("the permission key", () => {
  it("is the name OpenCode gives a tool-server tool: the server, an underscore, the tool", () => {
    expect(SECRET_TOOL_NAME).toBe("secret_request");
    expect(KEY).toBe("oncue_secret_request");
  });
});

describe("a held tool call", () => {
  it("is remembered when OpenCode asks, and nothing is sent until its input is seen", () => {
    const step = onPermissionAsked(INITIAL_SECRETS, ASKED, CTX);
    expect(step.effects).toEqual([]);
    expect(step.state.waiting).toEqual({
      requestId: "per_1",
      callId: "call_1",
      ref: "ref_1",
      name: null,
      asked: false,
    });
  });

  it("asks the control plane once the held call shows the name it wants", () => {
    const asked = onPermissionAsked(INITIAL_SECRETS, ASKED, CTX).state;
    const pending = onToolPart(asked, { callId: "call_1", status: "pending", input: {} });
    expect(pending.effects).toEqual([]);

    const running = onToolPart(pending.state, {
      callId: "call_1",
      status: "running",
      input: { name: "STRIPE_TEST_KEY" },
    });
    expect(running.effects).toEqual([
      { kind: "emit_request", ref: "ref_1", name: "STRIPE_TEST_KEY", callId: "call_1" },
    ]);
    expect(running.state.waiting).toMatchObject({ name: "STRIPE_TEST_KEY", asked: true });

    // The part is re-sent while it waits: one request, not two.
    expect(
      onToolPart(running.state, {
        callId: "call_1",
        status: "running",
        input: { name: "STRIPE_TEST_KEY" },
      }).effects,
    ).toEqual([]);
  });

  it.each([
    ["no name", {}],
    ["a name that is not text", { name: 7 }],
    ["a name that is not a variable's name", { name: "../../etc/passwd" }],
  ])("is rejected at once for %s, and never reaches the control plane", (_label, input) => {
    const asked = onPermissionAsked(INITIAL_SECRETS, ASKED, CTX).state;
    const step = onToolPart(asked, { callId: "call_1", status: "running", input });
    expect(step.effects).toEqual([
      {
        kind: "reply_permission",
        requestId: "per_1",
        reply: "reject",
        message: "That is not a secret's name. Names are capital letters, digits, and underscores.",
      },
    ]);
    expect(step.state.waiting).toBeNull();
  });

  it("is let through at once for a name this sandbox already holds: no authority is involved", () => {
    const supplied: SecretsState = { ...INITIAL_SECRETS, supplied: ["STRIPE_TEST_KEY"] };
    const asked = onPermissionAsked(supplied, ASKED, CTX).state;
    const step = onToolPart(asked, {
      callId: "call_1",
      status: "running",
      input: { name: "STRIPE_TEST_KEY" },
    });
    expect(step.effects).toEqual([
      { kind: "reply_permission", requestId: "per_1", reply: "once", message: null },
    ]);
    expect(step.state.waiting).toBeNull();
  });

  it.each([
    ["another kind of request", { ...ASKED, permission: "bash" }, CTX],
    ["a request with no run active", ASKED, { ...CTX, runActive: false }],
  ])("rejects %s", (_label, asked, ctx) => {
    const step = onPermissionAsked(INITIAL_SECRETS, asked, ctx);
    expect(step.effects).toMatchObject([
      { kind: "reply_permission", requestId: "per_1", reply: "reject" },
    ]);
    expect(step.state.waiting).toBeNull();
  });

  it("rejects a second request while one waits, and keeps the first", () => {
    const first = waitingFor();
    const step = onPermissionAsked(first, { ...ASKED, requestId: "per_2", callId: "call_2" }, CTX);
    expect(step.effects).toMatchObject([
      { kind: "reply_permission", requestId: "per_2", reply: "reject" },
    ]);
    expect(step.state.waiting?.requestId).toBe("per_1");
  });

  it("is forgotten, with no reply, when the call ends some other way", () => {
    const step = onToolPart(waitingFor(), { callId: "call_1", status: "error", input: {} });
    expect(step.effects).toEqual([]);
    expect(step.state.waiting).toBeNull();
    // Another call's parts change nothing.
    const other = onToolPart(waitingFor(), { callId: "call_9", status: "error", input: {} });
    expect(other.state.waiting).not.toBeNull();
  });
});

describe("a request held back while a permission card is out", () => {
  const asked = () => onPermissionAsked(INITIAL_SECRETS, ASKED, CTX).state;
  const named = () =>
    onToolPart(
      asked(),
      { callId: "call_1", status: "running", input: { name: "STRIPE_TEST_KEY" } },
      true,
    );

  it("is named but not sent, so the object never sees two cards", () => {
    const step = named();
    expect(step.effects).toEqual([]);
    expect(step.state.waiting).toMatchObject({ name: "STRIPE_TEST_KEY", asked: false });
    expect(hasUnsentRequest(step.state)).toBe(true);
    expect(hasUnsentRequest(asked())).toBe(false);
    expect(hasUnsentRequest(INITIAL_SECRETS)).toBe(false);
    expect(hasUnsentRequest(waitingFor())).toBe(false);
  });

  it("is sent once that card is answered, and only once", () => {
    const held = named().state;
    expect(pump(held, true)).toEqual({ state: held, effects: [] });
    const sent = pump(held, false);
    expect(sent.effects).toEqual([
      { kind: "emit_request", ref: "ref_1", name: "STRIPE_TEST_KEY", callId: "call_1" },
    ]);
    expect(pump(sent.state, false).effects).toEqual([]);
    expect(pump(asked(), false).effects).toEqual([]);
    expect(pump(INITIAL_SECRETS, false).effects).toEqual([]);
  });
});

describe("a request the harness settled", () => {
  it("is forgotten when it was never shown", () => {
    const unshown = onPermissionAsked(INITIAL_SECRETS, ASKED, CTX).state;
    expect(onRequestSettled(unshown, { requestId: "per_1" }).state.waiting).toBeNull();
    expect(onRequestSettled(unshown, { except: "per_9" }).state.waiting).toBeNull();
  });

  it("is kept when its card is out, or when the settled request is another", () => {
    const shown = waitingFor();
    expect(onRequestSettled(shown, { requestId: "per_1" }).state).toBe(shown);
    const unshown = onPermissionAsked(INITIAL_SECRETS, ASKED, CTX).state;
    expect(onRequestSettled(unshown, { requestId: "per_9" }).state).toBe(unshown);
    expect(onRequestSettled(unshown, { except: "per_1" }).state).toBe(unshown);
    expect(onRequestSettled(INITIAL_SECRETS, { requestId: "per_1" }).state).toBe(INITIAL_SECRETS);
  });
});

describe("what the control plane says", () => {
  it("arms a timer past the card's expiry, so the call ends even with the socket down", () => {
    const step = onApprovalFrame(waitingFor(), {
      requestRef: "ref_1",
      outcome: "pending",
      expiresAt: "2026-09-21T12:10:00.000Z",
    });
    // The grace lets the object's own expiry, or a late click, arrive first.
    expect(step.effects).toEqual([
      {
        kind: "approval_timer",
        ref: "ref_1",
        atMs: Date.parse("2026-09-21T12:10:00.000Z") + DEADLINE_GRACE_MS,
      },
    ]);
    expect(step.state.waiting).not.toBeNull();
  });

  it.each([
    // A word never releases a secret; only its grant does.
    ["allowed", "OnCue does not offer that here"],
    ["refused", "OnCue does not offer that here"],
    ["denied", "The user denied"],
    ["expired", "Nobody answered"],
    ["unavailable", "could not be read"],
  ] as const)("rejects the held call when the request was %s", (outcome, words) => {
    const step = onApprovalFrame(waitingFor(), { requestRef: "ref_1", outcome, expiresAt: null });
    expect(step.effects).toMatchObject([
      { kind: "reply_permission", requestId: "per_1", reply: "reject" },
    ]);
    expect(
      (step.effects[0] as { message: string }).message.includes(words),
      (step.effects[0] as { message: string }).message,
    ).toBe(true);
    expect(step.state.waiting).toBeNull();
  });

  it("ignores a frame about a request it is not waiting on", () => {
    const state = waitingFor();
    const step = onApprovalFrame(state, {
      requestRef: "ref_other",
      outcome: "denied",
      expiresAt: null,
    });
    expect(step.effects).toEqual([
      { kind: "log", line: "an approval frame for no waiting request" },
    ]);
    expect(step.state).toBe(state);
    expect(
      onApprovalFrame(INITIAL_SECRETS, { requestRef: "ref_1", outcome: "denied", expiresAt: null })
        .state.waiting,
    ).toBeNull();
  });

  it("rejects the held call when its own timer fires, and ignores a timer for an older request", () => {
    const state = waitingFor();
    expect(onApprovalDeadline(state, "ref_1")).toMatchObject({
      state: { waiting: null },
      effects: [{ kind: "reply_permission", requestId: "per_1", reply: "reject" }],
    });
    expect(onApprovalDeadline(state, "ref_old")).toEqual({ state, effects: [] });
    expect(onApprovalDeadline(INITIAL_SECRETS, "ref_1").effects).toEqual([]);
  });
});

describe("a secret grant", () => {
  const launch = {
    grantId: "grant_1",
    secrets: [{ name: "DATABASE_URL", value: FAKE_VALUE }],
    requestRef: null,
  };

  it("hands the values to the supervisor and keeps names only", () => {
    const step = onSecretGrant(INITIAL_SECRETS, launch);
    expect(step.effects).toEqual([
      { kind: "write_secrets", grantId: "grant_1", secrets: launch.secrets },
    ]);
    expect(JSON.stringify(step.state)).not.toContain(FAKE_VALUE);
    expect(step.state.writes).toEqual([
      { grantId: "grant_1", names: ["DATABASE_URL"], requestRef: null },
    ]);
  });

  it("is acknowledged only once written, and then the names count as supplied", () => {
    const granted = onSecretGrant(INITIAL_SECRETS, launch).state;
    const step = onSecretsWritten(granted, "grant_1", []);
    expect(step.effects).toEqual([{ kind: "ack", grantId: "grant_1", accepted: true }]);
    expect(step.state).toMatchObject({ supplied: ["DATABASE_URL"], writes: [] });
  });

  it("releases the held call only after the value it waited for is written", () => {
    const granted = onSecretGrant(waitingFor(), {
      grantId: "grant_2",
      secrets: [{ name: "STRIPE_TEST_KEY", value: FAKE_VALUE }],
      requestRef: "ref_1",
    });
    expect(granted.effects.map((effect) => effect.kind)).toEqual(["write_secrets"]);

    const written = onSecretsWritten(granted.state, "grant_2", []);
    expect(written.effects).toEqual([
      { kind: "ack", grantId: "grant_2", accepted: true },
      { kind: "reply_permission", requestId: "per_1", reply: "once", message: null },
    ]);
    expect(written.state).toMatchObject({ waiting: null, supplied: ["STRIPE_TEST_KEY"] });
  });

  it("rejects the grant and the held call when the supervisor could not write, keeping what did land", () => {
    const granted = onSecretGrant(waitingFor(), {
      grantId: "grant_3",
      secrets: [
        { name: "STRIPE_TEST_KEY", value: FAKE_VALUE },
        { name: "SENTRY_DSN", value: FAKE_VALUE },
      ],
      requestRef: "ref_1",
    }).state;
    const step = onSecretsWritten(granted, "grant_3", ["STRIPE_TEST_KEY"]);
    expect(step.effects).toMatchObject([
      { kind: "ack", grantId: "grant_3", accepted: false },
      { kind: "reply_permission", requestId: "per_1", reply: "reject" },
    ]);
    expect(step.state).toMatchObject({ waiting: null, supplied: ["SENTRY_DSN"] });
  });

  it("answers for a grant whose request is no longer waiting without replying to anything", () => {
    const granted = onSecretGrant(INITIAL_SECRETS, { ...launch, requestRef: "ref_gone" }).state;
    expect(onSecretsWritten(granted, "grant_1", []).effects).toEqual([
      { kind: "ack", grantId: "grant_1", accepted: true },
    ]);
  });

  it("ignores a write result for a grant it never saw", () => {
    expect(onSecretsWritten(INITIAL_SECRETS, "grant_x", [])).toEqual({
      state: INITIAL_SECRETS,
      effects: [{ kind: "log", line: "secrets written for a grant nobody sent" }],
    });
  });

  it("does not list a name twice when it is supplied again", () => {
    let state = onSecretsWritten(onSecretGrant(INITIAL_SECRETS, launch).state, "grant_1", []).state;
    state = onSecretGrant(state, { ...launch, grantId: "grant_again" }).state;
    expect(onSecretsWritten(state, "grant_again", []).state.supplied).toEqual(["DATABASE_URL"]);
  });
});

describe("endings", () => {
  it("rejects a held call when its run ends: an aborted call leaves its request behind in OpenCode", () => {
    expect(onRunEnded(waitingFor())).toMatchObject({
      state: { waiting: null },
      effects: [{ kind: "reply_permission", requestId: "per_1", reply: "reject" }],
    });
    expect(onRunEnded(INITIAL_SECRETS)).toEqual({ state: INITIAL_SECRETS, effects: [] });
  });

  it("clears every secret at shutdown, held call or not", () => {
    const supplied: SecretsState = { ...waitingFor(), supplied: ["DATABASE_URL"] };
    const step = onShutdown(supplied);
    expect(step.effects.map((effect) => effect.kind)).toEqual([
      "reply_permission",
      "clear_secrets",
    ]);
    expect(step.state).toEqual(INITIAL_SECRETS);
    // A grant still being written counts: its files may land after this.
    const writing = onSecretGrant(INITIAL_SECRETS, {
      grantId: "grant_w",
      secrets: [{ name: "A_NAME", value: FAKE_VALUE }],
      requestRef: null,
    }).state;
    expect(onShutdown(writing).effects).toEqual([{ kind: "clear_secrets" }]);
    // Nothing was ever sent, so nothing is asked of the supervisor.
    expect(onShutdown(INITIAL_SECRETS).effects).toEqual([]);
  });
});

describe("the tool's answer", () => {
  it("names the file for a supplied secret and never the value", () => {
    const state: SecretsState = { ...INITIAL_SECRETS, supplied: ["DATABASE_URL"] };
    const answer = secretToolAnswer(state, "DATABASE_URL", pathOf);
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("/var/lib/oncue/secrets/DATABASE_URL");
    expect(answer.text).toContain("environment variable");
  });

  it("says not supplied for anything else, whoever let the call through", () => {
    // The permission gate is cooperative: the agent can answer it itself on
    // loopback. What it gets then is this, because no value was ever sent.
    for (const name of ["STRIPE_TEST_KEY", "../../etc/passwd", ""]) {
      const answer = secretToolAnswer(INITIAL_SECRETS, name, pathOf);
      expect(answer).toEqual({
        isError: true,
        text: "That secret has not been supplied to this session. Continue without it, and tell the user what could not be done.",
      });
    }
  });
});
