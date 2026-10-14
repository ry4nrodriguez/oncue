// How a model's catalog facts read on the Model providers page.
import type { EffortLevel } from "@oncue/protocol";
import type { ModelSpecSummary } from "@/lib/api/setup";

/** "$4 in / $20 out per MTok": the provider's list price on the catalog's date. */
export function formatPrice(spec: ModelSpecSummary): string {
  return `$${spec.price.inputPerMTok} in / $${spec.price.outputPerMTok} out per MTok`;
}

/** "1M" or "200K" of context. */
export function formatContext(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Number.parseFloat((tokens / 1_000_000).toFixed(2))}M`
    : `${Math.round(tokens / 1000)}K`;
}

/** "low · medium · high", in the provider's own words, or that the model has no such setting. */
export function formatEffortLevels(levels: readonly EffortLevel[] | null): string {
  return levels === null ? "No effort setting" : levels.join(" · ");
}
