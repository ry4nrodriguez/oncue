// Calls the sandbox controller's `/v1/connection/test`. Not a `SandboxDriver`
// method: it has no session, generation, or reference.
//
// The token pair travels in headers only, never in a URL or body, and failure
// reasons are a closed set chosen here, so a pasted credential cannot come
// back out through an error message. A rejected credential is a 200 with
// `{"kind":"failed"}`; a non-200 means the controller refused OnCue itself.

import { safeJsonParse } from "../json";

export const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 20_000;

/**
 * An unknown reason from a newer controller becomes `unreachable`.
 * `no_environment_access` is a valid credential that can see no Environment (a
 * Modal service user with no role yet); calling it rejected would send the
 * user to mint a replacement that fails the same way.
 */
export type ModalTestFailureReason =
  | "invalid_credentials"
  | "no_environment_access"
  | "unreachable"
  /** OnCue's own controller token was refused, or no controller is configured. */
  | "controller_unavailable";

export type ModalCredentialTestResult =
  | {
      readonly kind: "ok";
      readonly workspaceName: string;
      readonly environments: readonly string[];
    }
  | { readonly kind: "failed"; readonly reason: ModalTestFailureReason };

/** The pasted pair and the Environment to act in. Never logged, never stored unsealed. */
export interface ModalCredential {
  readonly tokenId: string;
  readonly tokenSecret: string;
  /** `null` means the Modal workspace's default Environment. */
  readonly environmentName: string | null;
}

/** OnCue's own controller settings, not a user's credential. */
export interface ModalControllerAccess {
  readonly origin: string;
  readonly controllerToken: string;
}

export interface ModalCredentialTestOptions {
  readonly access: ModalControllerAccess;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

/** The seam `worker/modal/connections.ts` depends on, so a test needs no controller. */
export type ModalCredentialTester = (
  credential: ModalCredential,
) => Promise<ModalCredentialTestResult>;

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object") {
    return undefined;
  }
  if (value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function isReason(
  value: unknown,
): value is Exclude<ModalTestFailureReason, "controller_unavailable"> {
  return (
    value === "invalid_credentials" || value === "no_environment_access" || value === "unreachable"
  );
}

/** `null` if any element is not a string. */
function readEnvironments(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    names.push(item);
  }
  return names;
}

function readOk(value: unknown): ModalCredentialTestResult | null {
  const workspaceName = field(value, "workspaceName");
  if (typeof workspaceName !== "string" || workspaceName.length === 0) {
    return null;
  }
  const environments = readEnvironments(field(value, "environments"));
  if (environments === null) {
    return null;
  }
  return { kind: "ok", workspaceName, environments };
}

export function parseControllerTestResponse(
  status: number,
  body: unknown,
): ModalCredentialTestResult {
  if (status === 401) {
    // A controller that rejects this deployment's token is OnCue's fault, not
    // the user's credential.
    return { kind: "failed", reason: "controller_unavailable" };
  }
  if (status !== 200) {
    return { kind: "failed", reason: "unreachable" };
  }
  const kind = field(body, "kind");
  if (kind === "failed") {
    const reason = field(body, "reason");
    return { kind: "failed", reason: isReason(reason) ? reason : "unreachable" };
  }
  if (kind !== "ok") {
    return { kind: "failed", reason: "unreachable" };
  }
  return readOk(field(body, "value")) ?? { kind: "failed", reason: "unreachable" };
}

/** The credential is a parameter, so no tester instance holds a token between calls. */
export function createModalCredentialTester(
  options: ModalCredentialTestOptions,
): ModalCredentialTester {
  return async (credential: ModalCredential): Promise<ModalCredentialTestResult> => {
    // Built before the try: a token a header cannot carry is a bad paste, not
    // an unreachable controller.
    let headers: Headers;
    try {
      headers = new Headers({
        authorization: `Bearer ${options.access.controllerToken}`,
        "x-oncue-modal-token-id": credential.tokenId,
        "x-oncue-modal-token-secret": credential.tokenSecret,
      });
      if (credential.environmentName !== null) {
        headers.set("x-oncue-modal-environment", credential.environmentName);
      }
    } catch {
      return { kind: "failed", reason: "invalid_credentials" };
    }

    let response: Response;
    try {
      response = await options.fetchImpl(`${options.access.origin}/v1/connection/test`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      // The thrown error is not reported: it can carry the credential headers.
      return { kind: "failed", reason: "controller_unavailable" };
    }
    const parsed = safeJsonParse(await response.text());
    // A non-JSON body is passed as `undefined`; the parser answers from the status.
    return parseControllerTestResponse(response.status, parsed.ok ? parsed.value : undefined);
  };
}
