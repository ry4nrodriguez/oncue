// The Anthropic adapter: request shaping, credential header, and error
// vocabulary. Retry safety lives in `forward.ts`, connection rows in
// `connections.ts`, and the models in `catalog.ts`.

import { safeJsonParse } from "../../json";
import {
  credentialHint,
  fetchOrNull,
  isPlainObject,
  type ProviderAdapter,
  type ProviderCategory,
  readStringField,
} from "./adapter";
import { ANTHROPIC_MODELS, recommendedModel } from "./catalog";

const ANTHROPIC_VERSION = "2023-06-01";

function anthropicHeaders(credential: string): Headers {
  const headers = new Headers();
  anthropicAdapter.applyCredential(headers, credential);
  return headers;
}

/**
 * One status per `if` keeps every branch reachable by a table test.
 * `errorCode` is unused: the status alone separates these failures.
 *
 * Credit exhaustion is unverified: Anthropic documents no distinct code for it
 * beyond the generic 400 `invalid_request_error`, so it falls under
 * `request_rejected`. Only a test against the real API can settle it.
 */
function classify(status: number, _errorCode: string | null): ProviderCategory {
  if (status === 401) {
    return "authentication_failed";
  }
  if (status === 403) {
    return "authentication_failed";
  }
  if (status === 404) {
    return "model_unavailable";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 413) {
    return "request_rejected";
  }
  if (status === 400) {
    return "request_rejected";
  }
  if (status >= 500) {
    return "temporary_service_failure";
  }
  return "request_rejected";
}

/** Anthropic's error envelope: `{ type: "error", error: { type, message } }`. */
function errorCodeOf(body: unknown): string | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const error = body.error;
  if (!isPlainObject(error)) {
    return null;
  }
  return readStringField(error, "type");
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  defaultModel: recommendedModel("anthropic"),
  models: ANTHROPIC_MODELS,
  origin: "https://api.anthropic.com",
  requestPath: "/v1/messages",
  // Free, and counted with the same key (docs.anthropic.com, "Token counting").
  countPath: "/v1/messages/count_tokens",
  forwardedRequestHeaders: ["anthropic-beta"],
  applyCredential(headers, credential) {
    headers.set("x-api-key", credential);
    headers.set("anthropic-version", ANTHROPIC_VERSION);
  },
  async validate(input) {
    const response = await fetchOrNull(
      input.fetchImpl,
      `${input.origin}/v1/models`,
      anthropicHeaders(input.credential),
    );
    if (response === null) {
      return { kind: "failed", category: "temporary_service_failure" };
    }
    if (response.ok) {
      return { kind: "ok", accountHint: credentialHint(input.credential) };
    }
    const bodyText = await response.text();
    const parsed = safeJsonParse(bodyText);
    const errorCode = parsed.ok ? errorCodeOf(parsed.value) : null;
    return { kind: "failed", category: classify(response.status, errorCode) };
  },
  classify,
  errorCodeOf,
};
