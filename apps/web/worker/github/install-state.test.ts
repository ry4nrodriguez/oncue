import { describe, expect, it } from "vitest";
import { encodeBase64Url } from "../base64url";
import { currentKey, deriveKeyring, type Keyring } from "../broker/envelope";
import {
  checkInstallState,
  INSTALL_STATE_TTL_MS,
  type InstallStateSubject,
  mintInstallState,
} from "./install-state";

const NOW = 1_800_000_000_000;

const SUBJECT: InstallStateSubject = { workspaceId: "wsp_1", userId: "usr_1" };

function randomKeyText(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function tokenKeyring(secret: string): Promise<Keyring<"token">> {
  const result = await deriveKeyring(secret, "token");
  if (result.kind !== "ok") {
    throw new Error(`expected a keyring, got ${result.kind}`);
  }
  return result.keyring;
}

function oneVersion(): Promise<Keyring<"token">> {
  return tokenKeyring(`1:${randomKeyText()}`);
}

describe("mintInstallState", () => {
  it("round-trips the subject it was minted for", async () => {
    const keyring = await oneVersion();

    const state = await mintInstallState(keyring, SUBJECT, NOW);
    const check = await checkInstallState(keyring, state, NOW);

    expect(check).toEqual({
      kind: "valid",
      claims: {
        workspaceId: "wsp_1",
        userId: "usr_1",
        nonce: expect.any(String),
        issuedAt: NOW,
        expiresAt: NOW + INSTALL_STATE_TTL_MS,
      },
    });
  });

  // Not for secrecy: a state unique per click can serve as a correlation id.
  it("mints a different value for the same subject at the same instant", async () => {
    const keyring = await oneVersion();

    const first = await mintInstallState(keyring, SUBJECT, NOW);
    const second = await mintInstallState(keyring, SUBJECT, NOW);

    expect(first).not.toBe(second);
  });

  // The bundle secret scanner matches GitHub's token prefixes, so the tag must
  // not collide with them.
  it("carries a format tag that no GitHub token pattern matches", async () => {
    const state = await mintInstallState(await oneVersion(), SUBJECT, NOW);

    expect(state.startsWith("ois1.")).toBe(true);
    expect(/\b(ghs|ghu|gho|ghp)_/.test(state)).toBe(false);
  });
});

describe("checkInstallState", () => {
  it("refuses a value with the wrong number of parts", async () => {
    const keyring = await oneVersion();

    expect(await checkInstallState(keyring, "ois1.1.payload", NOW)).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });

  it("refuses a value carrying another format tag", async () => {
    const keyring = await oneVersion();
    const state = await mintInstallState(keyring, SUBJECT, NOW);

    const swapped = `ot1.${state.slice(state.indexOf(".") + 1)}`;

    expect(await checkInstallState(keyring, swapped, NOW)).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });

  // A rotated-away key version is distinct from a bad signature: the bytes may
  // be genuine.
  it("refuses a version the keyring no longer carries", async () => {
    const minted = await mintInstallState(await oneVersion(), SUBJECT, NOW);
    const other = await oneVersion();

    const rotatedPast = minted.replace("ois1.1.", "ois1.9.");

    expect(await checkInstallState(other, rotatedPast, NOW)).toEqual({
      kind: "rejected",
      reason: "unknown_key_version",
    });
  });

  it("refuses a signature that is not base64url", async () => {
    const keyring = await oneVersion();
    const state = await mintInstallState(keyring, SUBJECT, NOW);
    const withoutSignature = state.slice(0, state.lastIndexOf("."));

    expect(await checkInstallState(keyring, `${withoutSignature}.not base64!`, NOW)).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });

  it("refuses a state signed by a different deployment's keyring", async () => {
    const theirs = await tokenKeyring(`1:${randomKeyText()}`);
    const ours = await tokenKeyring(`1:${randomKeyText()}`);

    const forged = await mintInstallState(theirs, SUBJECT, NOW);

    expect(await checkInstallState(ours, forged, NOW)).toEqual({
      kind: "rejected",
      reason: "bad_signature",
    });
  });

  // An edited payload never reaches `JSON.parse`.
  it("refuses a payload edited to name another workspace", async () => {
    const keyring = await oneVersion();
    const state = await mintInstallState(keyring, SUBJECT, NOW);
    const parts = state.split(".");
    const tampered = encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          wid: "wsp_victim",
          uid: "usr_1",
          non: "n",
          iat: NOW,
          exp: NOW + INSTALL_STATE_TTL_MS,
        }),
      ),
    );

    const forged = `${parts.at(0)}.${parts.at(1)}.${tampered}.${parts.at(3)}`;

    expect(await checkInstallState(keyring, forged, NOW)).toEqual({
      kind: "rejected",
      reason: "bad_signature",
    });
  });

  it("refuses a state that has expired", async () => {
    const keyring = await oneVersion();
    const state = await mintInstallState(keyring, SUBJECT, NOW);

    expect(await checkInstallState(keyring, state, NOW + INSTALL_STATE_TTL_MS)).toEqual({
      kind: "rejected",
      reason: "expired",
    });
  });

  it("accepts a state one millisecond before it expires", async () => {
    const keyring = await oneVersion();
    const state = await mintInstallState(keyring, SUBJECT, NOW);

    const check = await checkInstallState(keyring, state, NOW + INSTALL_STATE_TTL_MS - 1);

    expect(check.kind).toBe("valid");
  });
});

// Correctly signed but the wrong shape, as a Worker of another version could
// produce during a rollout.
describe("checkInstallState on a genuine signature over an unexpected payload", () => {
  async function signRawPayload(keyring: Keyring<"token">, encoded: string): Promise<string> {
    const signedInput = `ois1.1.${encoded}`;
    const signature = await crypto.subtle.sign(
      "HMAC",
      currentKey(keyring),
      new TextEncoder().encode(signedInput) as BufferSource,
    );
    return `${signedInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  }

  function signPayload(keyring: Keyring<"token">, payload: unknown): Promise<string> {
    return signRawPayload(
      keyring,
      encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload))),
    );
  }

  const complete = { wid: "wsp_1", uid: "usr_1", non: "n", iat: NOW, exp: NOW + 1000 };

  const cases: readonly [string, unknown][] = [
    ["a payload that is not an object", "wsp_1"],
    ["a null payload", null],
    ["no workspace id", { ...complete, wid: 1 }],
    ["no user id", { ...complete, uid: 1 }],
    ["no nonce", { ...complete, non: 1 }],
    ["no issued-at", { ...complete, iat: "now" }],
    ["no expiry", { ...complete, exp: "later" }],
  ];

  for (const [what, payload] of cases) {
    it(`refuses ${what} as malformed`, async () => {
      const keyring = await oneVersion();

      const state = await signPayload(keyring, payload);

      expect(await checkInstallState(keyring, state, NOW)).toEqual({
        kind: "rejected",
        reason: "malformed",
      });
    });
  }

  it("refuses a payload that is not JSON at all", async () => {
    const keyring = await oneVersion();

    const state = await signPayload(keyring, undefined);

    expect(await checkInstallState(keyring, state, NOW)).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });

  // The signature covers the payload string, so a non-base64url payload still
  // verifies and reaches the decode failure.
  it("refuses a genuinely signed payload that is not base64url", async () => {
    const keyring = await oneVersion();

    const state = await signRawPayload(keyring, "not base64!");

    expect(await checkInstallState(keyring, state, NOW)).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });
});
