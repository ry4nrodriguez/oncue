// The OpenAI adapter: request shaping, credential header, and error
// vocabulary. The models come from `catalog.ts`.

import { safeJsonParse } from "../../json";
import {
  credentialHint,
  fetchOrNull,
  isPlainObject,
  type ProviderAdapter,
  type ProviderCategory,
  readStringField,
} from "./adapter";
import { OPENAI_MODELS, recommendedModel } from "./catalog";

function openaiHeaders(credential: string): Headers {
  const headers = new Headers();
  openaiAdapter.applyCredential(headers, credential);
  return headers;
}

/**
 * One signal per `if` keeps every branch reachable by a table test. A 429 is
 * ambiguous for OpenAI: rate limiting and exhausted quota differ only in
 * `error.code`.
 */
function classify(status: number, errorCode: string | null): ProviderCategory {
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
    if (errorCode === "insufficient_quota") {
      return "usage_limit_reached";
    }
    return "rate_limited";
  }
  if (status === 400) {
    return "request_rejected";
  }
  if (status >= 500) {
    return "temporary_service_failure";
  }
  return "request_rejected";
}

/**
 * `{ error: { message, type, param, code } }`. `code` is preferred because it
 * carries `insufficient_quota`; `type` is the fallback.
 */
function errorCodeOf(body: unknown): string | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const error = body.error;
  if (!isPlainObject(error)) {
    return null;
  }
  const code = readStringField(error, "code");
  if (code !== null) {
    return code;
  }
  return readStringField(error, "type");
}

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  defaultModel: recommendedModel("openai"),
  models: OPENAI_MODELS,
  origin: "https://api.openai.com",
  // The runtime's OpenAI client uses the Responses API by default, and Chat
  // Completions has no function calling on GPT-6 Astra.
  requestPath: "/v1/responses",
  forwardedRequestHeaders: [],
  applyCredential(headers, credential) {
    headers.set("authorization", `Bearer ${credential}`);
  },
  async validate(input) {
    const response = await fetchOrNull(
      input.fetchImpl,
      `${input.origin}/v1/models`,
      openaiHeaders(input.credential),
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
