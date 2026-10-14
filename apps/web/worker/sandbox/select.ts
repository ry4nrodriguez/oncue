// Which `SandboxDriver` a session runs on. A real sandbox needs both OnCue's
// controller bindings and the workspace's Modal credential; OnCue has no Modal
// account of its own to fall back on, so either missing means the fake.
//
// An unconfigured controller is expected locally (local sessions and tests).
// Anywhere else either gap would hand a user a scripted session, so
// `worker/routes/sessions.ts` refuses the create first: `refuseHostedStandIn`
// for a hosted deployment with no usable controller, `prepareModalCredential`
// for a missing credential where a controller exists. The branches here stay
// because a driver chosen by omission is the failure to prevent.
//
// The selection travels with the driver and is stored in
// `sandbox_attachment.provider`, so which driver ran a generation is recorded,
// not inferred.

import type { ModalCredential } from "../modal/client";
import type { SandboxDriver } from "./driver";
import { createFakeSandboxDriver, type FakeSandboxDriverOptions } from "./fake-driver";
import { createModalSandboxDriver, DEFAULT_CONTROLLER_TIMEOUT_MS } from "./modal-driver";
import { type ControllerBindings, readControllerConfig } from "./origin";

export type SandboxProvider = "fake" | "modal";

export interface SandboxDriverSelection {
  readonly provider: SandboxProvider;
  readonly driver: SandboxDriver;
}

export function selectSandboxDriver(
  bindings: ControllerBindings,
  envName: string,
  fake: FakeSandboxDriverOptions,
  fetchImpl: typeof fetch,
  credential: ModalCredential | null,
): SandboxDriverSelection {
  const config = readControllerConfig(bindings, envName);
  if (config.kind === "unconfigured") {
    return { provider: "fake", driver: createFakeSandboxDriver(fake) };
  }
  if (credential === null) {
    return { provider: "fake", driver: createFakeSandboxDriver(fake) };
  }
  return {
    provider: "modal",
    driver: createModalSandboxDriver({
      settings: config.settings,
      credential,
      fetchImpl,
      timeoutMs: DEFAULT_CONTROLLER_TIMEOUT_MS,
    }),
  };
}
