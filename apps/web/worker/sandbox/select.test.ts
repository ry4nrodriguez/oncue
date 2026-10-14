import { describe, expect, it } from "vitest";
import type { ModalCredential } from "../modal/client";
import type { BridgeSocketSink, FakeSandboxDriverOptions } from "./fake-driver";
import type { ControllerBindings } from "./origin";
import { selectSandboxDriver } from "./select";

const CONFIGURED: ControllerBindings = {
  ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://oncue--controller.modal.run",
  ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
};

const CREDENTIAL: ModalCredential = {
  tokenId: "ak-token-id",
  tokenSecret: "as-token-secret",
  environmentName: null,
};

const SINK: BridgeSocketSink = { openBridgeSocket: () => {} };
const FAKE: FakeSandboxDriverOptions = { failures: {}, sink: SINK };

function neverCalled(): never {
  throw new Error("the fake driver must not reach the network");
}

describe("selectSandboxDriver", () => {
  it("runs on the fake when no controller is configured", async () => {
    const selection = selectSandboxDriver(
      {},
      "local",
      FAKE,
      neverCalled as unknown as typeof fetch,
      CREDENTIAL,
    );

    expect(selection.provider).toBe("fake");
    // The fake creates in memory and never touches `fetchImpl`.
    await expect(
      selection.driver.create({
        sessionId: "sess_1",
        generation: 1,
        imageReference: "fake",
        resourceClass: "standard",
        regionPreference: null,
        expirationPolicy: "idle_20m",
        bootstrapCredential: "boot_sess_1_1",
      }),
    ).resolves.toEqual({ kind: "ok", value: { sessionId: "sess_1", generation: 1 } });
  });

  // In the product, record 13's mandatory Modal step keeps a user out of this
  // position; local sessions and tests run in it.
  it("runs on the fake when the workspace has no Modal credential", async () => {
    const selection = selectSandboxDriver(
      CONFIGURED,
      "hosted",
      FAKE,
      neverCalled as unknown as typeof fetch,
      null,
    );

    expect(selection.provider).toBe("fake");
  });

  it("runs on the controller when the bindings and the credential are both there", async () => {
    const calls: string[] = [];
    const sent: (string | null)[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(url);
      sent.push(new Headers(init.headers).get("x-oncue-modal-token-id"));
      return new Response(JSON.stringify({ kind: "ok", value: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const selection = selectSandboxDriver(CONFIGURED, "hosted", FAKE, fetchImpl, CREDENTIAL);
    await selection.driver.start({ sessionId: "sess_1", generation: 1 });

    expect(selection.provider).toBe("modal");
    expect(calls).toEqual(["https://oncue--controller.modal.run/v1/start"]);
    // The workspace's credential reaches the controller; no deployment binding exists.
    expect(sent).toEqual(["ak-token-id"]);
  });
});
