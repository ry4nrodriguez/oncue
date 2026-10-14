import { describe, expect, it } from "vitest";
import { currentKey, deriveKeyring, type Keyring } from "./envelope";
import {
  checkForForward,
  checkForRefresh,
  mintToken,
  renewToken,
  TOKEN_REFRESH_WINDOW_MS,
  TOKEN_TTL_MS,
  type TokenScope,
} from "./tokens";

const NOW = 1_800_000_000_000;

const SCOPE: TokenScope = {
  sessionId: "sess_1",
  sandboxGeneration: 4,
  connectionId: "mc_1",
  workspaceId: "wsp_1",
  modelId: "claude-sonnet-4-5",
  effort: null,
};

function randomKeyText(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function tokenKeyring(secret: string): Promise<Keyring<"token">> {
  const result = await deriveKeyring(secret, "token");
  if (result.kind !== "ok") {
    throw new Error(`expected a keyring, got ${result.kind}`);
  }
  return result.keyring;
}

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Signs an arbitrary payload with the keyring's own current key. */
async function hmac(keyring: Keyring<"token">, signedInput: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    currentKey(keyring),
    new TextEncoder().encode(signedInput) as BufferSource,
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("mintToken", () => {
  it("carries the whole scope and nothing else", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);

    const token = await mintToken(keyring, SCOPE, NOW);
    const check = await checkForForward(keyring, token, NOW + 1000);
    if (check.kind !== "valid") {
      throw new Error(`expected a valid token, got ${check.reason}`);
    }

    expect(check.claims).toEqual({
      ...SCOPE,
      issuedAt: NOW,
      expiresAt: NOW + TOKEN_TTL_MS,
      refreshableUntil: NOW + TOKEN_REFRESH_WINDOW_MS,
    });
  });

  it("names its key version outside the signature, so a wrong one fails the verify", async () => {
    const keyring = await tokenKeyring(`9:${randomKeyText()}`);

    const token = await mintToken(keyring, SCOPE, NOW);

    expect(token.split(".")[0]).toBe("ot1");
    expect(token.split(".")[1]).toBe("9");
    expect(token.split(".")).toHaveLength(4);
  });

  // Pins the claim set, so a new field carrying something it should not fails
  // a test.
  it("carries exactly the nine claims and nothing else", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);

    const token = await mintToken(keyring, SCOPE, NOW);
    const payload = token.split(".")[2] as string;
    const claims = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as Record<
      string,
      unknown
    >;

    expect(Object.keys(claims).sort()).toEqual(
      ["cid", "eff", "exp", "gen", "iat", "mid", "rex", "sid", "wid"].sort(),
    );
  });
});

describe("checkForForward", () => {
  it("carries the effort the token was minted for, as a level or as none", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    const high = await checkForForward(
      keyring,
      await mintToken(keyring, { ...SCOPE, effort: "high" }, NOW),
      NOW,
    );
    expect(high).toMatchObject({ kind: "valid", claims: { effort: "high" } });
    const none = await checkForForward(keyring, await mintToken(keyring, SCOPE, NOW), NOW);
    expect(none).toMatchObject({ kind: "valid", claims: { effort: null } });
  });

  it("accepts a fresh token", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(keyring, SCOPE, NOW);

    expect((await checkForForward(keyring, token, NOW)).kind).toBe("valid");
  });

  it("refuses a token at the moment it expires, not a tick later", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(keyring, SCOPE, NOW);

    expect(await checkForForward(keyring, token, NOW + TOKEN_TTL_MS)).toEqual({
      kind: "rejected",
      reason: "expired",
    });
    expect((await checkForForward(keyring, token, NOW + TOKEN_TTL_MS - 1)).kind).toBe("valid");
  });

  // The workspace and connection are signed, so a caller cannot edit either.
  it("refuses a token whose claims were edited", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(keyring, SCOPE, NOW);
    const [format, version, payload, signature] = token.split(".") as [
      string,
      string,
      string,
      string,
    ];
    const decoded = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    const edited = base64Url(decoded.replace('"wsp_1"', '"wsp_2"'));

    expect(
      await checkForForward(keyring, `${format}.${version}.${edited}.${signature}`, NOW),
    ).toEqual({ kind: "rejected", reason: "bad_signature" });
  });

  it("refuses a token signed by an unrelated keyring of the same version", async () => {
    const mine = await tokenKeyring(`1:${randomKeyText()}`);
    const theirs = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(theirs, SCOPE, NOW);

    expect(await checkForForward(mine, token, NOW)).toEqual({
      kind: "rejected",
      reason: "bad_signature",
    });
  });

  it("reports a retired key version distinctly from a forged signature", async () => {
    const before = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(before, SCOPE, NOW);
    const after = await tokenKeyring(`2:${randomKeyText()}`);

    expect(await checkForForward(after, token, NOW)).toEqual({
      kind: "rejected",
      reason: "unknown_key_version",
    });
  });

  it("still verifies a token minted under an older version the keyring kept", async () => {
    const oldKey = randomKeyText();
    const before = await tokenKeyring(`1:${oldKey}`);
    const token = await mintToken(before, SCOPE, NOW);
    const after = await tokenKeyring(`2:${randomKeyText()},1:${oldKey}`);

    expect((await checkForForward(after, token, NOW)).kind).toBe("valid");
  });

  const malformed: readonly [string, string][] = [
    ["too few segments", "ot1.1.abc"],
    ["too many segments", "ot1.1.abc.def.ghi"],
    ["an unknown format tag", "ot2.1.abc.def"],
    ["a signature outside the base64url alphabet", "ot1.1.abc.!!!!"],
  ];

  for (const [name, token] of malformed) {
    it(`refuses a token with ${name}`, async () => {
      const keyring = await tokenKeyring(`1:${randomKeyText()}`);

      expect(await checkForForward(keyring, token, NOW)).toEqual({
        kind: "rejected",
        reason: "malformed",
      });
    });
  }
});

describe("claims that pass the signature but not the shape", () => {
  const cases: readonly [string, string][] = [
    ["a payload that is not base64url", "!!!!"],
    ["a payload that is not JSON", base64Url("not json at all")],
    ["a payload that is not an object", base64Url('"a string"')],
    ["a null payload", base64Url("null")],
  ];

  for (const [name, payload] of cases) {
    it(`refuses ${name}`, async () => {
      const keyring = await tokenKeyring(`1:${randomKeyText()}`);
      const version = (await mintToken(keyring, SCOPE, NOW)).split(".")[1] as string;
      const signedInput = `ot1.${version}.${payload}`;
      const token = `${signedInput}.${await hmac(keyring, signedInput)}`;

      expect(await checkForForward(keyring, token, NOW)).toEqual({
        kind: "rejected",
        reason: "malformed",
      });
    });
  }

  const fields = ["sid", "gen", "cid", "wid", "mid", "eff", "iat", "exp", "rex"] as const;

  for (const field of fields) {
    it(`refuses claims whose ${field} has the wrong type`, async () => {
      const keyring = await tokenKeyring(`1:${randomKeyText()}`);
      const version = (await mintToken(keyring, SCOPE, NOW)).split(".")[1] as string;
      const good: Record<string, unknown> = {
        sid: "sess_1",
        gen: 4,
        cid: "mc_1",
        wid: "wsp_1",
        mid: "m",
        eff: null,
        iat: NOW,
        exp: NOW + 1000,
        rex: NOW + 2000,
      };
      // Each field gets the wrong type; `eff` may be null or a level, and "one"
      // is neither.
      good[field] = typeof good[field] === "string" ? 1 : "one";
      const payload = base64Url(JSON.stringify(good));
      const signedInput = `ot1.${version}.${payload}`;
      const token = `${signedInput}.${await hmac(keyring, signedInput)}`;

      expect(await checkForForward(keyring, token, NOW)).toEqual({
        kind: "rejected",
        reason: "malformed",
      });
    });
  }
});

describe("refresh", () => {
  it("accepts a token that has already expired, which is the whole point", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(keyring, SCOPE, NOW);
    const wellPastExpiry = NOW + TOKEN_TTL_MS + 60_000;

    expect((await checkForForward(keyring, token, wellPastExpiry)).kind).toBe("rejected");
    expect((await checkForRefresh(keyring, token, wellPastExpiry)).kind).toBe("valid");
  });

  it("refuses a token past its ceiling", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(keyring, SCOPE, NOW);

    expect(await checkForRefresh(keyring, token, NOW + TOKEN_REFRESH_WINDOW_MS)).toEqual({
      kind: "rejected",
      reason: "not_refreshable",
    });
  });

  it("refuses a malformed token at refresh too, not only at forward", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);

    expect(await checkForRefresh(keyring, "ot1.1.abc", NOW)).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });

  // Refreshing never moves the ceiling, so a leaked token is bounded by when it
  // was first issued.
  it("never walks the ceiling forward, however many times it renews", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    let token = await mintToken(keyring, SCOPE, NOW);
    let at = NOW;

    for (let renewal = 0; renewal < 5; renewal += 1) {
      at += TOKEN_TTL_MS - 1;
      const check = await checkForRefresh(keyring, token, at);
      if (check.kind !== "valid") {
        throw new Error(`renewal ${renewal} was refused: ${check.reason}`);
      }
      token = await renewToken(keyring, check.claims, at);
    }

    const final = await checkForForward(keyring, token, at);
    if (final.kind !== "valid") {
      throw new Error("expected the renewed token to still forward");
    }
    expect(final.claims.refreshableUntil).toBe(NOW + TOKEN_REFRESH_WINDOW_MS);
    expect(final.claims.sandboxGeneration).toBe(SCOPE.sandboxGeneration);
  });

  // The cap is what lets a forward check one clock instead of two.
  it("caps a late renewal's expiry at the ceiling", async () => {
    const keyring = await tokenKeyring(`1:${randomKeyText()}`);
    const token = await mintToken(keyring, SCOPE, NOW);
    const nearCeiling = NOW + TOKEN_REFRESH_WINDOW_MS - 1000;
    const check = await checkForRefresh(keyring, token, nearCeiling);
    if (check.kind !== "valid") {
      throw new Error("expected the token to still be refreshable");
    }

    const renewed = await renewToken(keyring, check.claims, nearCeiling);
    const verified = await checkForForward(keyring, renewed, nearCeiling);
    if (verified.kind !== "valid") {
      throw new Error("expected the renewed token to verify");
    }

    expect(verified.claims.expiresAt).toBe(NOW + TOKEN_REFRESH_WINDOW_MS);
    expect((await checkForForward(keyring, renewed, NOW + TOKEN_REFRESH_WINDOW_MS)).kind).toBe(
      "rejected",
    );
  });
});
