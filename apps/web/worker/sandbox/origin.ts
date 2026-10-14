// Where sandbox-controller traffic goes. The controller is a Modal app the
// Worker reaches over HTTPS, because Workers cannot make gRPC calls and Modal
// has no REST interface for sandboxes (record 02).
//
// All settings are required together. Unconfigured runs local sessions on the
// fake driver; a hosted deployment refuses to create a session instead
// (`refuseHostedStandIn` in `worker/routes/sessions.ts`). The `provider` column
// on `sandbox_attachment` records which driver ran.
//
// `envName` is a plain `string` because `env.ONCUE_ENV` is typed as the literal
// "local", and comparing it inline narrows to `never`.
//
// These bindings grant no Modal authority. The token pair is the user's, from
// `modal_connection` per session; a deployment-wide pair would make one Modal
// account pay for every user's sandboxes.

export interface ControllerBindings {
  readonly ONCUE_SANDBOX_CONTROLLER_ORIGIN?: string | undefined;
  readonly ONCUE_SANDBOX_CONTROLLER_TOKEN?: string | undefined;
}

export interface ControllerSettings {
  readonly origin: string;
  readonly controllerToken: string;
}

export type ControllerConfig =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "configured"; readonly settings: ControllerSettings };

/** Empty counts as absent. */
function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

/**
 * Plain HTTP only locally. A hosted request carries the user's Modal token
 * pair, which must never cross an unencrypted hop.
 */
function isUsableOrigin(origin: string, envName: string): boolean {
  if (origin.startsWith("https://")) {
    return true;
  }
  if (envName !== "local") {
    return false;
  }
  return origin.startsWith("http://");
}

export function readControllerConfig(
  bindings: ControllerBindings,
  envName: string,
): ControllerConfig {
  const origin = nonEmpty(bindings.ONCUE_SANDBOX_CONTROLLER_ORIGIN);
  const controllerToken = nonEmpty(bindings.ONCUE_SANDBOX_CONTROLLER_TOKEN);
  if (origin === null) {
    return { kind: "unconfigured" };
  }
  if (controllerToken === null) {
    return { kind: "unconfigured" };
  }
  if (!isUsableOrigin(origin, envName)) {
    return { kind: "unconfigured" };
  }
  return { kind: "configured", settings: { origin, controllerToken } };
}
