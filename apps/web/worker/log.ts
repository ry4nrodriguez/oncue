const LOG_FIELD_NAMES = [
  "timestamp",
  "severity",
  "service",
  "release",
  "environment",
  "region",
  "requestId",
  "traceId",
  "sessionId",
  "runId",
  "sandboxGeneration",
  "deliveryId",
  "operation",
  "result",
  "durationMs",
  "retryCount",
  "errorCategory",
  "provider",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

export const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set(LOG_FIELD_NAMES);

type LogFieldName = (typeof LOG_FIELD_NAMES)[number];

export type LogFields = {
  timestamp: string;
  severity: "debug" | "info" | "warn" | "error";
  service: string;
  release: string;
  environment: string;
  operation: string;
  result: string;
  region?: string;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  runId?: string;
  sandboxGeneration?: string;
  deliveryId?: string;
  durationMs?: number;
  retryCount?: number;
  errorCategory?: string;
  /** The adapter's own name ("anthropic", "openai"), never read from the credential or request. */
  provider?: string;
  /**
   * The Model Broker's reading of the provider's usage counters for one
   * answer, in the provider's own meaning (`broker/stream-usage.ts`).
   * Integers only, never content.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export const ALLOWLIST_MATCHES_LOG_FIELDS: [
  Exclude<keyof LogFields, LogFieldName> extends never ? true : never,
  Exclude<LogFieldName, keyof LogFields> extends never ? true : never,
] = [true, true];

type RejectExtraKeys<T, Shape> = T & Record<Exclude<keyof T, keyof Shape>, never>;

export function log<T extends LogFields>(fields: RejectExtraKeys<T, LogFields>): void {
  for (const key of Object.keys(fields)) {
    if (!LOG_FIELD_ALLOWLIST.has(key)) {
      throw new Error(`log field not allowed: ${key}`);
    }
  }
  console.log(JSON.stringify(fields));
}
