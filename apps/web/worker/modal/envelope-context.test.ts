import { describe, expect, it } from "vitest";
import {
  type CredentialContext,
  deriveKeyring,
  type Keyring,
  openCredential,
  sealCredential,
} from "../broker/envelope";
import { modalTokenContext } from "./envelope-context";

/** Short and obviously fake, so secret scanners do not trip. */
const TOKEN_ID = "ak-fake0001";
const TOKEN_SECRET = "as-fake0001";
const GITHUB_TOKEN = "ghu_fake0001";

const CONNECTION = "mdl_1";
const WORKSPACE = "wsp_1";
const OTHER_WORKSPACE = "wsp_2";

function randomKeyText(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function credentialKeyring(): Promise<Keyring<"credential">> {
  const result = await deriveKeyring(`1:${randomKeyText()}`, "credential");
  if (result.kind !== "ok") {
    throw new Error(`expected a keyring, got ${result.kind}`);
  }
  return result.keyring;
}

describe("modalTokenContext", () => {
  it("binds the row, the workspace, and the half, with the half as the discriminator", () => {
    expect(modalTokenContext(CONNECTION, WORKSPACE, "token_id")).toEqual({
      connectionId: CONNECTION,
      workspaceId: WORKSPACE,
      provider: "modal_token_id",
    });
    expect(modalTokenContext(CONNECTION, WORKSPACE, "token_secret")).toEqual({
      connectionId: CONNECTION,
      workspaceId: WORKSPACE,
      provider: "modal_token_secret",
    });
  });
});

// Every credential type shares one keyring and cipher, so only the additional
// data keeps them apart. The two Modal halves share a row and a shape, so
// without a per-half discriminator a swap would open cleanly. Every case reads
// `tampered`: AES-GCM cannot tell a wrong context from a flipped byte.
describe("a Modal token half sealed under its context", () => {
  it("opens under its own context", async () => {
    const keyring = await credentialKeyring();
    const context = modalTokenContext(CONNECTION, WORKSPACE, "token_id");

    const sealed = await sealCredential(keyring, context, TOKEN_ID);

    expect(await openCredential(keyring, context, sealed)).toEqual({
      kind: "ok",
      plaintext: TOKEN_ID,
    });
  });

  it("does not open as the other half of its own row", async () => {
    const keyring = await credentialKeyring();
    const sealedSecret = await sealCredential(
      keyring,
      modalTokenContext(CONNECTION, WORKSPACE, "token_secret"),
      TOKEN_SECRET,
    );

    expect(
      await openCredential(
        keyring,
        modalTokenContext(CONNECTION, WORKSPACE, "token_id"),
        sealedSecret,
      ),
    ).toEqual({ kind: "tampered" });

    const sealedId = await sealCredential(
      keyring,
      modalTokenContext(CONNECTION, WORKSPACE, "token_id"),
      TOKEN_ID,
    );

    expect(
      await openCredential(
        keyring,
        modalTokenContext(CONNECTION, WORKSPACE, "token_secret"),
        sealedId,
      ),
    ).toEqual({ kind: "tampered" });
  });

  it("does not open under another workspace's context", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      modalTokenContext(CONNECTION, WORKSPACE, "token_id"),
      TOKEN_ID,
    );

    expect(
      await openCredential(
        keyring,
        modalTokenContext(CONNECTION, OTHER_WORKSPACE, "token_id"),
        sealed,
      ),
    ).toEqual({ kind: "tampered" });
  });

  it("does not open under another connection row's context", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      modalTokenContext(CONNECTION, WORKSPACE, "token_secret"),
      TOKEN_SECRET,
    );

    expect(
      await openCredential(keyring, modalTokenContext("mdl_2", WORKSPACE, "token_secret"), sealed),
    ).toEqual({ kind: "tampered" });
  });

  it("does not open as a model credential or a GitHub token for the same row", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      modalTokenContext(CONNECTION, WORKSPACE, "token_id"),
      TOKEN_ID,
    );

    for (const provider of ["anthropic", "github_user_token"]) {
      const foreign: CredentialContext = {
        connectionId: CONNECTION,
        workspaceId: WORKSPACE,
        provider,
      };
      expect(await openCredential(keyring, foreign, sealed)).toEqual({ kind: "tampered" });
    }
  });
});

describe("another provider's credential", () => {
  it("does not open as either Modal half for the same row and workspace", async () => {
    const keyring = await credentialKeyring();
    const asGitHub: CredentialContext = {
      connectionId: CONNECTION,
      workspaceId: WORKSPACE,
      provider: "github_user_token",
    };
    const sealed = await sealCredential(keyring, asGitHub, GITHUB_TOKEN);

    expect(
      await openCredential(keyring, modalTokenContext(CONNECTION, WORKSPACE, "token_id"), sealed),
    ).toEqual({ kind: "tampered" });
    expect(
      await openCredential(
        keyring,
        modalTokenContext(CONNECTION, WORKSPACE, "token_secret"),
        sealed,
      ),
    ).toEqual({ kind: "tampered" });
  });
});
