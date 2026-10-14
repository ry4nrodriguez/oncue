import { EFFORT_LEVELS, type EffortLevel } from "@oncue/protocol";
/**
 * The browser's copy of `worker/setup/derive.ts`'s `SetupState`, with a
 * defensive parser for the `setup` field of `GET /api/me`. The network call
 * lives in `features/auth/gate.ts`.
 */

export type GitHubStuckReason = "cancelled" | "no_repositories" | "pending_approval";

export interface RepositorySummary {
  readonly repositoryConnectionId: string;
  readonly fullName: string;
}

/** The providers the Worker's broker knows; see `worker/broker/providers/adapter.ts`. */
export type ModelProvider = "anthropic" | "openai";

/**
 * USD per million tokens. The cache prices are absent from an older body; the
 * cost estimate then prices cache reads and writes as plain input.
 */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

/**
 * One row of the Worker's model catalog for a connection's provider, as
 * `GET /api/setup` reports it: what the picker names, prices, and offers
 * effort levels from. Levels are the provider's own words.
 */
export interface ModelSpecSummary {
  readonly modelId: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly effort: readonly EffortLevel[] | null;
  readonly defaultEffort: EffortLevel | null;
  readonly price: ModelPrice;
  readonly status: "current" | "legacy";
  readonly recommended: boolean;
}

export interface ModelConnectionSummary {
  readonly modelConnectionId: string;
  readonly label: string;
  /** The catalog for this connection's provider. Absent from an older body; the picker then offers `modelId` alone. */
  readonly models?: readonly ModelSpecSummary[];
  /**
   * Whose key this is and which model a run on it charges. Optional so a
   * summary without them (a harness, an older body) still renders by label.
   */
  readonly provider?: ModelProvider;
  readonly modelId?: string;
}

/** Why a key stopped working, short of being revoked: it can be replaced in place. */
export type InactiveKeyStatus = "invalid" | "expired" | "attention_required";

/**
 * A connection whose key stopped working and can be replaced in place, which
 * keeps its id and its sessions. Never offered for a new session.
 */
export interface InactiveModelConnection {
  readonly modelConnectionId: string;
  readonly provider: ModelProvider;
  readonly status: InactiveKeyStatus;
  /** Active sessions on this key: each one's next model request needs it. */
  readonly activeSessions: number;
}

/**
 * A harness the composer may offer (`worker/runtime/resolve.ts`): allowed by
 * the deployment and carried by the image. The picker shows only when there
 * is more than one.
 */
export interface RuntimeSummary {
  readonly id: string;
  readonly name: string;
  readonly providers: readonly string[];
  readonly images: boolean;
  readonly holdsToolCalls: boolean;
}

/** Every provider's models, connected or not, as the Worker's catalog lists them. */
export type ModelCatalog = Readonly<Record<ModelProvider, readonly ModelSpecSummary[]>>;

export type SetupState =
  | { readonly kind: "connect_github"; readonly installUrl: string | null }
  | { readonly kind: "github_stuck"; readonly reason: GitHubStuckReason }
  /**
   * GitHub is connected and Modal is not. It carries `modelConnections`
   * because the skippable model-key step sits between them (`setup-step.ts`).
   */
  | {
      readonly kind: "connect_modal";
      readonly modelConnections: readonly ModelConnectionSummary[];
    }
  | {
      readonly kind: "ready";
      readonly repositories: readonly RepositorySummary[];
      readonly modelConnections: readonly ModelConnectionSummary[];
      /** The harnesses this deployment allows. Absent from an older body, which offered OpenCode alone and no choice. */
      readonly runtimes?: readonly RuntimeSummary[];
      /** Every provider's models, so the composer can list one whose key is missing. Absent from an older body. */
      readonly catalog?: ModelCatalog;
      /** Keys that stopped working. Absent when there are none, and from an older body. */
      readonly inactiveModelConnections?: readonly InactiveModelConnection[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStuckReason(value: string): value is GitHubStuckReason {
  return value === "cancelled" || value === "no_repositories" || value === "pending_approval";
}

function parseRepository(raw: unknown): RepositorySummary | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.repositoryConnectionId !== "string" || typeof raw.fullName !== "string") {
    return null;
  }
  return { repositoryConnectionId: raw.repositoryConnectionId, fullName: raw.fullName };
}

function parseModelConnection(raw: unknown): ModelConnectionSummary | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw.modelConnectionId !== "string" || typeof raw.label !== "string") {
    return null;
  }
  const summary: ModelConnectionSummary = {
    modelConnectionId: raw.modelConnectionId,
    label: raw.label,
  };
  // Only a provider this build has a mark for, and only with a model id; one without the other cannot render.
  const models = parseModelSpecs(raw.models);
  if (
    (raw.provider === "anthropic" || raw.provider === "openai") &&
    typeof raw.modelId === "string"
  ) {
    return { ...summary, provider: raw.provider, modelId: raw.modelId, ...models };
  }
  return { ...summary, ...models };
}

function isInactiveKeyStatus(value: unknown): value is InactiveKeyStatus {
  return value === "invalid" || value === "expired" || value === "attention_required";
}

/** A key that stopped working, or nothing: a row this build cannot name is dropped. */
export function parseInactiveModelConnection(raw: unknown): InactiveModelConnection | null {
  if (
    !isRecord(raw) ||
    typeof raw.modelConnectionId !== "string" ||
    (raw.provider !== "anthropic" && raw.provider !== "openai") ||
    !isInactiveKeyStatus(raw.status)
  ) {
    return null;
  }
  const sessions = raw.activeSessions;
  return {
    modelConnectionId: raw.modelConnectionId,
    provider: raw.provider,
    status: raw.status,
    // A count that is not a whole number of sessions is not shown as one.
    activeSessions:
      typeof sessions === "number" && Number.isInteger(sessions) && sessions > 0 ? sessions : 0,
  };
}

/** Spread into the ready state: the field when the body named at least one such key, nothing otherwise. */
function parseInactiveModelConnections(raw: unknown): {
  readonly inactiveModelConnections?: readonly InactiveModelConnection[];
} {
  if (!Array.isArray(raw)) {
    return {};
  }
  const inactive = raw
    .map(parseInactiveModelConnection)
    .filter((connection): connection is InactiveModelConnection => connection !== null);
  return inactive.length === 0 ? {} : { inactiveModelConnections: inactive };
}

/** A harness the picker can draw, or nothing: a malformed row is dropped, never half-drawn. */
export function parseRuntimeSummary(raw: unknown): RuntimeSummary | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    !Array.isArray(raw.providers) ||
    !raw.providers.every((provider) => typeof provider === "string") ||
    typeof raw.images !== "boolean" ||
    typeof raw.holdsToolCalls !== "boolean"
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    providers: raw.providers as string[],
    images: raw.images,
    holdsToolCalls: raw.holdsToolCalls,
  };
}

function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function parsePrice(raw: Record<string, unknown>): ModelPrice {
  const price: {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
  } = { inputPerMTok: raw.inputPerMTok as number, outputPerMTok: raw.outputPerMTok as number };
  // A cache price that is not a number is left out, never guessed.
  if (typeof raw.cacheReadPerMTok === "number") {
    price.cacheReadPerMTok = raw.cacheReadPerMTok;
  }
  if (typeof raw.cacheWritePerMTok === "number") {
    price.cacheWritePerMTok = raw.cacheWritePerMTok;
  }
  return price;
}

/** A row the picker can draw, or nothing: a malformed row is dropped, never half-drawn. */
export function parseModelSpec(raw: unknown): ModelSpecSummary | null {
  if (!isRecord(raw) || !isRecord(raw.price)) {
    return null;
  }
  const effort = raw.effort;
  if (
    typeof raw.modelId !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.contextWindow !== "number" ||
    !(effort === null || (Array.isArray(effort) && effort.every(isEffortLevel))) ||
    !(raw.defaultEffort === null || isEffortLevel(raw.defaultEffort)) ||
    typeof raw.price.inputPerMTok !== "number" ||
    typeof raw.price.outputPerMTok !== "number" ||
    (raw.status !== "current" && raw.status !== "legacy") ||
    typeof raw.recommended !== "boolean"
  ) {
    return null;
  }
  return {
    modelId: raw.modelId,
    name: raw.name,
    contextWindow: raw.contextWindow,
    effort: effort === null ? null : [...(effort as EffortLevel[])],
    defaultEffort: raw.defaultEffort,
    price: parsePrice(raw.price),
    status: raw.status,
    recommended: raw.recommended,
  };
}

/** Spread into the summary: `{ models }` when the body carried a list, nothing otherwise. */
function parseModelSpecs(raw: unknown): { readonly models?: readonly ModelSpecSummary[] } {
  if (!Array.isArray(raw)) {
    return {};
  }
  return {
    models: raw.map(parseModelSpec).filter((spec): spec is ModelSpecSummary => spec !== null),
  };
}

function parseList<T>(raw: unknown, parseOne: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const result: T[] = [];
  for (const item of raw) {
    const parsed = parseOne(item);
    if (parsed === null) {
      return null;
    }
    result.push(parsed);
  }
  return result;
}

/** The catalog, or nothing when either provider's list is missing or holds a malformed row. */
export function parseCatalog(raw: unknown): ModelCatalog | null {
  if (!isRecord(raw)) {
    return null;
  }
  const parsed: Partial<Record<ModelProvider, readonly ModelSpecSummary[]>> = {};
  for (const provider of ["anthropic", "openai"] as const) {
    const list = raw[provider];
    if (!Array.isArray(list)) {
      return null;
    }
    const specs: ModelSpecSummary[] = [];
    for (const item of list) {
      const spec = parseModelSpec(item);
      if (spec === null) {
        return null;
      }
      specs.push(spec);
    }
    parsed[provider] = specs;
  }
  return parsed as ModelCatalog;
}

/**
 * Reads defensively, matching `gate.ts`'s `parseMeResponse`: any shape that
 * does not match one of the four variants exactly becomes `null` rather
 * than a best-effort guess.
 */
export function parseSetupState(raw: unknown): SetupState | null {
  if (!isRecord(raw)) {
    return null;
  }
  const kind = raw.kind;
  if (kind === "connect_github") {
    const installUrl: unknown = raw.installUrl;
    if (installUrl !== null && typeof installUrl !== "string") {
      return null;
    }
    return { kind: "connect_github", installUrl };
  }
  if (kind === "github_stuck") {
    const reason: unknown = raw.reason;
    if (typeof reason !== "string" || !isStuckReason(reason)) {
      return null;
    }
    return { kind: "github_stuck", reason };
  }
  if (kind === "connect_modal") {
    const modelConnections = parseList(raw.modelConnections, parseModelConnection);
    if (modelConnections === null) {
      return null;
    }
    return { kind: "connect_modal", modelConnections };
  }
  if (kind === "ready") {
    const repositories = parseList(raw.repositories, parseRepository);
    const modelConnections = parseList(raw.modelConnections, parseModelConnection);
    if (repositories === null || modelConnections === null) {
      return null;
    }
    // A malformed catalog is dropped whole: the composer then lists what is connected.
    const parsedCatalog = parseCatalog(raw.catalog);
    // A malformed key that stopped working is dropped alone: Home then says nothing about it.
    const extras = {
      ...(parsedCatalog === null ? {} : { catalog: parsedCatalog }),
      ...parseInactiveModelConnections(raw.inactiveModelConnections),
    };
    if (!Array.isArray(raw.runtimes)) {
      return { kind: "ready", repositories, modelConnections, ...extras };
    }
    const runtimes = raw.runtimes
      .map(parseRuntimeSummary)
      .filter((runtime): runtime is RuntimeSummary => runtime !== null);
    return { kind: "ready", repositories, modelConnections, runtimes, ...extras };
  }
  return null;
}
