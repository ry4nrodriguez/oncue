/**
 * Lookup tables as `Record`s over closed unions, so an unhandled case is a
 * compile error. `StatusTone` lives in `src/features/status-tone.ts` and is
 * re-exported here.
 */

import type { ModelFailureCategory } from "@oncue/protocol";
import type { ComponentType } from "react";
import { AnthropicMark, OpenAIMark } from "@/components/brand/icons";
import { type StatusTone, TONE_TEXT_CLASS } from "@/features/status-tone";
import type { ModelConnectionRow, ModelProvider } from "@/lib/api/model-connections";

export type { StatusTone };
export { TONE_TEXT_CLASS };

export interface StatusMeta {
  readonly label: string;
  readonly tone: StatusTone;
}

export const STATUS_META: Record<ModelConnectionRow["status"], StatusMeta> = {
  active: { label: "Active", tone: "positive" },
  attention_required: { label: "Attention required", tone: "caution" },
  invalid: { label: "Invalid", tone: "danger" },
  expired: { label: "Expired", tone: "danger" },
  revoked: { label: "Revoked", tone: "faint" },
};

export const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** A new provider without a mark is a compile error. Both marks draw in `currentColor`. */
export const PROVIDER_MARK: Record<ModelProvider, ComponentType<{ className?: string }>> = {
  anthropic: AnthropicMark,
  openai: OpenAIMark,
};

/** Record 06's plain-language sentence for each `ModelFailureCategory`, never the provider's own text. */
export const CATEGORY_MESSAGE: Record<ModelFailureCategory, string> = {
  temporary_service_failure: "The provider had a temporary problem. Try again in a moment.",
  rate_limited: "The provider is rate-limiting this key right now. Wait a moment and try again.",
  usage_limit_reached:
    "This key has reached its usage limit with the provider. Check your plan, or add a different key.",
  authentication_failed:
    "The provider rejected this key. Check that it is active and has not been revoked, then try again.",
  model_unavailable:
    "The provider doesn't currently support a model OnCue needs. Try again later or use a different connection.",
  request_rejected:
    "The provider rejected this request. Check the key's permissions and try again.",
  broker_failure:
    "OnCue couldn't complete this request. Try again, and reconnect if it keeps happening.",
};
