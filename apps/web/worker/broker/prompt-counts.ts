/**
 * Exact token counts for the parts of an agent's prompt that are not the
 * conversation: the system prompt, the harness's own tools, and OnCue's tools.
 * The provider's own counter (Anthropic's free `count_tokens`) does the
 * counting with the session's key, so every figure is the provider's, never
 * an estimate (`docs/decisions.md`).
 *
 * Counting is off the request's path: a forward answers with the counts it
 * already holds for this prompt, or says they are pending and starts counting
 * after the answer is on its way. A failure leaves no counts, never a guess.
 * Only hashes and integers are kept; no prompt text is stored or logged.
 */

/** The counts the browser shows, in the header's wire form. */
export interface PromptCounts {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly oncueToolsTokens: number;
}

/** The response header that carries them to the bridge's relay. */
export const PROMPT_COUNTS_HEADER = "x-oncue-prompt-tokens";

/**
 * Where a prompt stands when its counts are not in the header: being counted
 * (or about to be), or not countable for now (failures, a rate limit, or the
 * session's budget).
 */
export type PromptStatus = "pending" | "unavailable";

/**
 * The names OnCue's own tools reach a model under: `oncue_<tool>` from
 * OpenCode, Codex, and Pi, and `mcp__oncue__<tool>` from Claude Code
 * (`presentToolName` in each of `services/bridge/src`'s runtimes).
 */
export const ONCUE_TOOL_PREFIXES: readonly string[] = ["oncue_", "mcp__oncue__"];

/** How much of the prompt's SHA-256 the header carries: enough to tell a session's prompts apart. */
export const KEY_HEX_CHARS = 16;

/** After this many failures for one prompt, the browser is told the breakdown is unavailable. */
export const FAILURES_BEFORE_UNAVAILABLE = 2;

/** After the counter answers 429, this isolate counts nothing for that connection for this long. */
export const RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * At most this many distinct prompts are counted for one session in a window,
 * so a sandbox that changes its prompt on every call cannot use up the key's
 * rate limit that the person's other sessions share.
 */
export const SESSION_PROMPTS_PER_WINDOW = 10;
export const SESSION_WINDOW_MS = 10 * 60_000;

/**
 * The one message every count carries, since the counter needs one; its own
 * count is measured and subtracted.
 */
const MINIMAL_MESSAGES = [{ role: "user", content: "." }] as const;

/** How long one count may take before counting gives up for this prompt. */
export const COUNT_TIMEOUT_MS = 5_000;

/** After a failure, the same prompt is not counted again for this long, so a rate limit is not pressed. */
export const RETRY_AFTER_FAILURE_MS = 60_000;

/** Distinct prompts, sessions, and connections remembered per isolate; the oldest is forgotten first. */
export const MAX_REMEMBERED = 256;

/** The parts of a request body the counts describe, `cache_control` removed. */
export interface PromptShape {
  readonly model: string;
  readonly system: unknown;
  readonly harnessTools: readonly unknown[];
  readonly oncueTools: readonly unknown[];
}

/** Drops `cache_control` everywhere: a client moves its breakpoints, and they are not tokens. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCacheControl);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key !== "cache_control") {
      out[key] = withoutCacheControl(inner);
    }
  }
  return out;
}

/**
 * The prompt of an agent's call, or `null` for a request with no tools. A call
 * without tools is not the agent's turn (OpenCode's title request is one), so
 * it gets no counts and changes nothing the bridge holds.
 */
export function promptShapeOf(body: Record<string, unknown>): PromptShape | null {
  const tools = body.tools;
  if (typeof body.model !== "string" || !Array.isArray(tools) || tools.length === 0) {
    return null;
  }
  const isOncue = (tool: unknown) =>
    typeof tool === "object" &&
    tool !== null &&
    typeof (tool as { name?: unknown }).name === "string" &&
    ONCUE_TOOL_PREFIXES.some((prefix) => (tool as { name: string }).name.startsWith(prefix));
  const cleaned = withoutCacheControl(tools) as unknown[];
  return {
    model: body.model,
    system: withoutCacheControl(body.system ?? null),
    harnessTools: cleaned.filter((tool) => !isOncue(tool)),
    oncueTools: cleaned.filter(isOncue),
  };
}

/**
 * A SHA-256 of the shape: the cache key, and the only trace of the prompt
 * kept. The header carries its first `KEY_HEX_CHARS`, so the bridge can tie
 * counts to the call they belong to.
 */
export async function promptKey(shape: PromptShape): Promise<string> {
  const text = JSON.stringify([shape.model, shape.system, shape.harnessTools, shape.oncueTools]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One call to the provider's counter: a count, a rate limit, or any other failure. */
export type CountOutcome = number | "rate_limited" | "failed";
export type CountTokens = (body: Readonly<Record<string, unknown>>) => Promise<CountOutcome>;

/**
 * Counts cumulatively, so the parts add up to the whole prompt exactly: the
 * minimal message alone, then with the system prompt, then with the harness's
 * tools, then with OnCue's. Each part is a difference of two counts, and the
 * provider's tool-use preamble falls to the first tools counted.
 */
export async function countPrompt(
  shape: PromptShape,
  count: CountTokens,
): Promise<PromptCounts | "rate_limited" | "failed"> {
  const base = { model: shape.model, messages: MINIMAL_MESSAGES };
  const withSystem = shape.system === null ? base : { ...base, system: shape.system };
  const withHarness =
    shape.harnessTools.length === 0 ? withSystem : { ...withSystem, tools: shape.harnessTools };
  const withAll =
    shape.oncueTools.length === 0
      ? withHarness
      : { ...withSystem, tools: [...shape.harnessTools, ...shape.oncueTools] };
  const bodies = [base, withSystem, withHarness, withAll];
  // Identical bodies are counted once.
  const counted = new Map<object, Promise<CountOutcome>>();
  const results = await Promise.all(
    bodies.map((body) => {
      const known = counted.get(body);
      if (known !== undefined) {
        return known;
      }
      const pending = count(body);
      counted.set(body, pending);
      return pending;
    }),
  );
  if (results.includes("rate_limited")) {
    return "rate_limited";
  }
  const [c0, c1, c2, c3] = results;
  if (
    typeof c0 !== "number" ||
    typeof c1 !== "number" ||
    typeof c2 !== "number" ||
    typeof c3 !== "number"
  ) {
    return "failed";
  }
  const counts = {
    systemTokens: c1 - c0,
    toolsTokens: c2 - c1,
    oncueToolsTokens: c3 - c2,
  };
  // A part that counts below nothing means the counter is not additive here; show nothing rather than a guess.
  return counts.systemTokens < 0 || counts.toolsTokens < 0 || counts.oncueToolsTokens < 0
    ? "failed"
    : counts;
}

type Remembered =
  | { readonly kind: "counted"; readonly counts: PromptCounts }
  | { readonly kind: "counting"; readonly failures: number }
  | { readonly kind: "failed"; readonly at: number; readonly failures: number };

/** Who a count is for: the session's budget and the connection's rate limit. */
export interface CountScope {
  readonly sessionId: string;
  readonly connectionId: string;
}

/** What a forward does about a prompt: answer its counts, or a status and whether to start counting. */
export type CountDecision =
  | { readonly kind: "counts"; readonly counts: PromptCounts }
  | { readonly kind: "status"; readonly status: PromptStatus; readonly start: boolean };

/** A bounded map whose oldest entry goes first. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED) {
    map.delete(map.keys().next().value as string);
  }
}

/**
 * What one isolate remembers: counts by prompt key (final once known), each
 * session's recent starts, and each connection's rate-limit pause. A miss costs
 * at most four free counter calls, within the session's budget.
 */
export class PromptCountCache {
  private readonly prompts = new Map<string, Remembered>();
  private readonly sessionStarts = new Map<string, readonly number[]>();
  private readonly pausedUntil = new Map<string, number>();

  /** Whether to answer counts, or a status and whether to count now. Starting is recorded here. */
  decide(key: string, scope: CountScope, now: number): CountDecision {
    const entry = this.prompts.get(key);
    if (entry?.kind === "counted") {
      remember(this.prompts, key, entry);
      return { kind: "counts", counts: entry.counts };
    }
    if (entry?.kind === "counting") {
      return { kind: "status", status: "pending", start: false };
    }
    const failures = entry?.failures ?? 0;
    const shown: PromptStatus = failures >= FAILURES_BEFORE_UNAVAILABLE ? "unavailable" : "pending";
    if (entry?.kind === "failed" && now - entry.at < RETRY_AFTER_FAILURE_MS) {
      return { kind: "status", status: shown, start: false };
    }
    if ((this.pausedUntil.get(scope.connectionId) ?? 0) > now) {
      return { kind: "status", status: "unavailable", start: false };
    }
    const recent = (this.sessionStarts.get(scope.sessionId) ?? []).filter(
      (at) => now - at < SESSION_WINDOW_MS,
    );
    if (recent.length >= SESSION_PROMPTS_PER_WINDOW) {
      return { kind: "status", status: "unavailable", start: false };
    }
    remember(this.sessionStarts, scope.sessionId, [...recent, now]);
    remember(this.prompts, key, { kind: "counting", failures });
    return { kind: "status", status: shown, start: true };
  }

  /** Counts the prompt, remembering the counts, or the failure and any rate limit. */
  async fill(
    key: string,
    scope: CountScope,
    now: () => number,
    work: () => Promise<PromptCounts | "rate_limited" | "failed">,
  ): Promise<void> {
    const before = this.prompts.get(key);
    const failures = before?.kind === "counting" ? before.failures : 0;
    let outcome: PromptCounts | "rate_limited" | "failed";
    try {
      outcome = await work();
    } catch {
      outcome = "failed";
    }
    if (typeof outcome === "object") {
      remember(this.prompts, key, { kind: "counted", counts: outcome });
      return;
    }
    if (outcome === "rate_limited") {
      remember(this.pausedUntil, scope.connectionId, now() + RATE_LIMIT_PAUSE_MS);
    }
    remember(this.prompts, key, { kind: "failed", at: now(), failures: failures + 1 });
  }

  get size(): number {
    return this.prompts.size;
  }
}

/** One per isolate. Tests make their own. */
export const PROMPT_COUNT_CACHE = new PromptCountCache();

/** The header's value: the prompt's key with its counts, or with its status. */
export function promptCountsHeader(key: string, decision: CountDecision): string {
  const shortKey = key.slice(0, KEY_HEX_CHARS);
  return decision.kind === "counts"
    ? JSON.stringify({
        key: shortKey,
        systemTokens: decision.counts.systemTokens,
        toolsTokens: decision.counts.toolsTokens,
        oncueToolsTokens: decision.counts.oncueToolsTokens,
      })
    : JSON.stringify({ key: shortKey, status: decision.status });
}

/**
 * The provider's counter over HTTP: the same origin, credential headers, and
 * model as the forward. A 429 is a rate limit; anything else but a 200 with an
 * integer is a failure.
 */
export function providerCounter(input: {
  readonly fetchImpl: typeof fetch;
  readonly url: string;
  readonly headers: Headers;
}): CountTokens {
  return async (body) => {
    try {
      const answer = await input.fetchImpl(input.url, {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(COUNT_TIMEOUT_MS),
      });
      if (answer.status === 429) {
        return "rate_limited";
      }
      if (!answer.ok) {
        return "failed";
      }
      const parsed = (await answer.json()) as { input_tokens?: unknown };
      const tokens = parsed.input_tokens;
      return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0
        ? tokens
        : "failed";
    } catch {
      return "failed";
    }
  };
}
