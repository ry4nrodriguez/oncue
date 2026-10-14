import { describe, expect, it } from "vitest";
import {
  type CredentialContext,
  deriveKeyring,
  type Keyring,
  openCredential,
  sealCredential,
} from "../broker/envelope";
import { githubTokenContext } from "./envelope-context";

// Short on purpose: a realistic-length `ghu_` value would trip the secret
// scanners.
const USER_TOKEN = "ghu_fake0001";
const REFRESH_TOKEN = "ghr_fake0001";
const MODEL_KEY = "sk-ant-fake0001";

const INSTALLATION = "ghi_1";
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

describe("githubTokenContext", () => {
  it("binds the row, the workspace, and the kind, with the kind as the discriminator", () => {
    expect(githubTokenContext(INSTALLATION, WORKSPACE, "user_token")).toEqual({
      connectionId: INSTALLATION,
      workspaceId: WORKSPACE,
      provider: "github_user_token",
    });
    expect(githubTokenContext(INSTALLATION, WORKSPACE, "refresh_token")).toEqual({
      connectionId: INSTALLATION,
      workspaceId: WORKSPACE,
      provider: "github_refresh_token",
    });
  });
});

// Model credentials and GitHub tokens share one keyring and cipher, so only
// the additional data keeps them apart. Each case presents one value as
// another, and AES-GCM reports each as `tampered`, which is the right answer:
// none of them may be used.
describe("a GitHub token sealed under its context", () => {
  it("opens under its own context", async () => {
    const keyring = await credentialKeyring();
    const context = githubTokenContext(INSTALLATION, WORKSPACE, "user_token");

    const sealed = await sealCredential(keyring, context, USER_TOKEN);

    expect(await openCredential(keyring, context, sealed)).toEqual({
      kind: "ok",
      plaintext: USER_TOKEN,
    });
  });

  it("does not open as a model credential for the same connection id and workspace", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      githubTokenContext(INSTALLATION, WORKSPACE, "user_token"),
      USER_TOKEN,
    );

    const asModel: CredentialContext = {
      connectionId: INSTALLATION,
      workspaceId: WORKSPACE,
      provider: "anthropic",
    };

    expect(await openCredential(keyring, asModel, sealed)).toEqual({ kind: "tampered" });
  });

  it("does not open as the refresh token of the same row", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      githubTokenContext(INSTALLATION, WORKSPACE, "user_token"),
      USER_TOKEN,
    );

    expect(
      await openCredential(
        keyring,
        githubTokenContext(INSTALLATION, WORKSPACE, "refresh_token"),
        sealed,
      ),
    ).toEqual({ kind: "tampered" });
  });

  it("does not open as the user token when it was sealed as the refresh token", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      githubTokenContext(INSTALLATION, WORKSPACE, "refresh_token"),
      REFRESH_TOKEN,
    );

    expect(
      await openCredential(
        keyring,
        githubTokenContext(INSTALLATION, WORKSPACE, "user_token"),
        sealed,
      ),
    ).toEqual({ kind: "tampered" });
  });

  it("does not open under another workspace's context", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      githubTokenContext(INSTALLATION, WORKSPACE, "user_token"),
      USER_TOKEN,
    );

    expect(
      await openCredential(
        keyring,
        githubTokenContext(INSTALLATION, OTHER_WORKSPACE, "user_token"),
        sealed,
      ),
    ).toEqual({ kind: "tampered" });
  });

  it("does not open under another installation row's context", async () => {
    const keyring = await credentialKeyring();
    const sealed = await sealCredential(
      keyring,
      githubTokenContext(INSTALLATION, WORKSPACE, "user_token"),
      USER_TOKEN,
    );

    expect(
      await openCredential(keyring, githubTokenContext("ghi_2", WORKSPACE, "user_token"), sealed),
    ).toEqual({ kind: "tampered" });
  });
});

describe("a model credential sealed under its context", () => {
  it("does not open as a GitHub token for the same connection id and workspace", async () => {
    const keyring = await credentialKeyring();
    const asModel: CredentialContext = {
      connectionId: INSTALLATION,
      workspaceId: WORKSPACE,
      provider: "anthropic",
    };
    const sealed = await sealCredential(keyring, asModel, MODEL_KEY);

    expect(
      await openCredential(
        keyring,
        githubTokenContext(INSTALLATION, WORKSPACE, "user_token"),
        sealed,
      ),
    ).toEqual({ kind: "tampered" });
    expect(
      await openCredential(
        keyring,
        githubTokenContext(INSTALLATION, WORKSPACE, "refresh_token"),
        sealed,
      ),
    ).toEqual({ kind: "tampered" });
  });
});
