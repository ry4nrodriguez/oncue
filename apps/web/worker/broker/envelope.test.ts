import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type CredentialContext,
  currentKey,
  currentVersion,
  deriveKeyring,
  type Keyring,
  keyAt,
  openCredential,
  sealCredential,
} from "./envelope";

/** Too short to match the secret scanners' provider-key pattern, which cannot tell a fixture from a real key. */
const API_KEY = "sk-ant-fake0001";

const CONTEXT: CredentialContext = {
  connectionId: "mc_1",
  workspaceId: "wsp_1",
  provider: "anthropic",
};

function randomKeyText(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function credentialKeyring(secret: string): Promise<Keyring<"credential">> {
  const result = await deriveKeyring(secret, "credential");
  if (result.kind !== "ok") {
    throw new Error(`expected a keyring, got ${result.kind}`);
  }
  return result.keyring;
}

describe("deriveKeyring", () => {
  it("reads the binding the test runner supplies", async () => {
    const result = await deriveKeyring(env.ONCUE_BROKER_KEYRING, "credential");

    expect(result.kind).toBe("ok");
  });

  it("reports an absent secret as unconfigured rather than malformed", async () => {
    expect((await deriveKeyring(undefined, "credential")).kind).toBe("unconfigured");
  });

  it("reports a blank secret as unconfigured", async () => {
    expect((await deriveKeyring("   ", "credential")).kind).toBe("unconfigured");
  });

  it("takes the FIRST entry as the current version, so rotation is a prepend", async () => {
    const keyring = await credentialKeyring(`7:${randomKeyText()},6:${randomKeyText()}`);

    expect(currentVersion(keyring)).toBe("7");
  });

  it("accepts a single-entry keyring, the shape a fresh clone gets", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);

    expect(currentVersion(keyring)).toBe("1");
    expect(keyAt(keyring, "1")).not.toBeNull();
  });

  it("hands back the current key without a lookup that could miss", async () => {
    const keyring = await credentialKeyring(`3:${randomKeyText()},2:${randomKeyText()}`);

    expect(currentKey(keyring)).toBe(keyAt(keyring, "3"));
  });

  it("answers null for a version it does not carry", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);

    expect(keyAt(keyring, "9")).toBeNull();
  });

  const malformed: readonly [string, string, string][] = [
    ["an entry with no colon", `1${randomKeyText()}`, "an entry is not version:key"],
    ["an entry with an empty version", `:${randomKeyText()}`, "an entry has no version"],
    ["an entry whose version is only spaces", ` :${randomKeyText()}`, "an entry has no version"],
    ["a key outside the base64url alphabet", "1:!!!!", "a key is not base64url"],
    ["a key that is not 32 bytes", "1:c2hvcnQ", "a key is not 32 bytes"],
    ["a trailing empty entry", `1:${randomKeyText()},`, "an entry is empty"],
    ["a malformed entry after a good one", `1:${randomKeyText()},2:!!!!`, "a key is not base64url"],
  ];

  for (const [name, secret, detail] of malformed) {
    it(`refuses ${name}`, async () => {
      const result = await deriveKeyring(secret, "credential");

      expect(result).toEqual({ kind: "malformed", detail });
    });
  }

  it("refuses a keyring that names one version twice", async () => {
    const secret = `1:${randomKeyText()},1:${randomKeyText()}`;

    expect(await deriveKeyring(secret, "credential")).toEqual({
      kind: "malformed",
      detail: "a version appears twice",
    });
  });

  // One secret holds both purposes: a credential sealed under one is
  // unopenable by the other, and the token key is HMAC and cannot decrypt.
  it("derives unrelated keys for the credential and token purposes", async () => {
    const secret = `1:${randomKeyText()}`;
    const forCredentials = await credentialKeyring(secret);
    const tokenResult = await deriveKeyring(secret, "token");
    if (tokenResult.kind !== "ok") {
      throw new Error("expected a token keyring");
    }

    const credentialKey = keyAt(forCredentials, "1");
    const tokenKey = keyAt(tokenResult.keyring, "1");

    expect(credentialKey?.algorithm.name).toBe("AES-GCM");
    expect(tokenKey?.algorithm.name).toBe("HMAC");
  });
});

describe("sealCredential and openCredential", () => {
  it("round-trips a credential", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);

    const sealed = await sealCredential(keyring, CONTEXT, API_KEY);

    expect(await openCredential(keyring, CONTEXT, sealed)).toEqual({
      kind: "ok",
      plaintext: API_KEY,
    });
  });

  // Asserts on the stored string, since a round trip could pass with a no-op
  // cipher.
  it("stores a versioned ciphertext that contains no part of the key", async () => {
    const keyring = await credentialKeyring(`4:${randomKeyText()}`);

    const sealed = await sealCredential(keyring, CONTEXT, API_KEY);

    expect(sealed.startsWith("oncue1.4.")).toBe(true);
    expect(sealed.includes(API_KEY)).toBe(false);
    expect(sealed.includes("sk-ant")).toBe(false);
    expect(sealed.split(".")).toHaveLength(4);
  });

  it("uses a fresh nonce per value, so the same key seals differently every time", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);

    const first = await sealCredential(keyring, CONTEXT, API_KEY);
    const second = await sealCredential(keyring, CONTEXT, API_KEY);

    expect(first).not.toBe(second);
    expect(first.split(".")[2]).not.toBe(second.split(".")[2]);
  });

  // After rotation, an older value still opens under the version it recorded.
  it("opens a value sealed under an older version after rotation", async () => {
    const oldKey = randomKeyText();
    const before = await credentialKeyring(`1:${oldKey}`);
    const sealed = await sealCredential(before, CONTEXT, API_KEY);

    const after = await credentialKeyring(`2:${randomKeyText()},1:${oldKey}`);

    expect(currentVersion(after)).toBe("2");
    expect(await openCredential(after, CONTEXT, sealed)).toEqual({
      kind: "ok",
      plaintext: API_KEY,
    });
  });

  it("reports a version the keyring no longer carries, rather than failing blind", async () => {
    const before = await credentialKeyring(`1:${randomKeyText()}`);
    const sealed = await sealCredential(before, CONTEXT, API_KEY);

    const retired = await credentialKeyring(`2:${randomKeyText()}`);

    expect(await openCredential(retired, CONTEXT, sealed)).toEqual({
      kind: "unknown_key_version",
      version: "1",
    });
  });

  it("refuses a value sealed under an unrelated key of the same version", async () => {
    const mine = await credentialKeyring(`1:${randomKeyText()}`);
    const theirs = await credentialKeyring(`1:${randomKeyText()}`);
    const sealed = await sealCredential(theirs, CONTEXT, API_KEY);

    expect(await openCredential(mine, CONTEXT, sealed)).toEqual({ kind: "tampered" });
  });

  // Flip a decoded byte, not a base64 character: the last character can land
  // on padding bits that decode to the same bytes.
  it("refuses a ciphertext with a flipped byte", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);
    const sealed = await sealCredential(keyring, CONTEXT, API_KEY);
    const [format, version, nonce, cipher] = sealed.split(".") as [string, string, string, string];
    const bytes = Uint8Array.from(atob(cipher.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const flipped = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(flipped).not.toBe(cipher);

    expect(
      await openCredential(keyring, CONTEXT, `${format}.${version}.${nonce}.${flipped}`),
    ).toEqual({ kind: "tampered" });
  });

  // The additional data binds the row, so a bug in the authorization query
  // cannot disclose a credential on its own.
  it("refuses a ciphertext lifted into another connection's row", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);
    const sealed = await sealCredential(keyring, CONTEXT, API_KEY);

    const otherRow: CredentialContext = { ...CONTEXT, connectionId: "mc_2" };

    expect(await openCredential(keyring, otherRow, sealed)).toEqual({ kind: "tampered" });
  });

  it("refuses a ciphertext lifted into another workspace's row", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);
    const sealed = await sealCredential(keyring, CONTEXT, API_KEY);

    const otherWorkspace: CredentialContext = { ...CONTEXT, workspaceId: "wsp_2" };

    expect(await openCredential(keyring, otherWorkspace, sealed)).toEqual({ kind: "tampered" });
  });

  it("refuses a ciphertext relabelled as another provider", async () => {
    const keyring = await credentialKeyring(`1:${randomKeyText()}`);
    const sealed = await sealCredential(keyring, CONTEXT, API_KEY);

    const otherProvider: CredentialContext = { ...CONTEXT, provider: "openai" };

    expect(await openCredential(keyring, otherProvider, sealed)).toEqual({ kind: "tampered" });
  });

  const unreadable: readonly [string, string][] = [
    ["a value with too few segments", "oncue1.1.abc"],
    ["a value with too many segments", "oncue1.1.abc.def.ghi"],
    ["a value in an unknown format", "oncue2.1.abc.def"],
    ["a nonce outside the base64url alphabet", "oncue1.1.!!!!.def"],
    ["a ciphertext outside the base64url alphabet", "oncue1.1.abcdefghijkl.!!!!"],
  ];

  for (const [name, sealed] of unreadable) {
    it(`reports ${name} as malformed`, async () => {
      const keyring = await credentialKeyring(`1:${randomKeyText()}`);

      expect(await openCredential(keyring, CONTEXT, sealed)).toEqual({ kind: "malformed" });
    });
  }
});
