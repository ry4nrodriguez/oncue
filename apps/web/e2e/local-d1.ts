/**
 * The tests' way to read and write the local D1 while the dev server runs.
 * Statements go through Miniflare's local explorer
 * (`/cdn-cgi/local/explorer/api/d1/...`, served in `vite dev` only), inside the
 * process that owns the SQLite file: a second `wrangler d1 execute` process
 * opening it fails intermittently under parallel workers.
 *
 * Each string is one statement: the explorer returns only the last result of a
 * string holding several, so a second statement is refused.
 */

import { appOrigin } from "./app-origin";

export type Row = Record<string, unknown>;

const EXPLORER_PATH = "/cdn-cgi/local/explorer/api/d1/database";
const BINDING = "DB";

/** What the explorer answers, as far as these tests read it. */
export interface ExplorerAnswer {
  readonly success?: boolean;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
  readonly result?:
    | readonly {
        readonly results?: { readonly columns?: readonly string[]; readonly rows?: unknown[][] };
      }[]
    | null;
}

/**
 * Refuses a string that holds a second statement: a semicolon outside a
 * quoted literal or identifier, followed by anything but whitespace.
 */
export function assertOneStatement(sql: string): void {
  let quote: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === ";" && sql.slice(index + 1).trim().length > 0) {
      throw new Error(
        "local D1: pass one statement per string (an array for several); the explorer returns only the last result of a joined string",
      );
    }
  }
}

/** One array of rows per statement, each row keyed by column name. */
export function rowsOf(answer: ExplorerAnswer): Row[][] {
  return (answer.result ?? []).map((result) => {
    const columns = result.results?.columns ?? [];
    return (result.results?.rows ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])),
    );
  });
}

/**
 * Why a query failed, from the explorer's own error messages. The statement is
 * never echoed: a seeding statement can carry a sealed credential.
 */
export function failureReason(status: number, answer: ExplorerAnswer | null): string {
  const messages = (answer?.errors ?? [])
    .map((error) => error.message ?? "")
    .filter((message) => message.length > 0);
  const detail = messages.length > 0 ? messages.join(" | ") : "no error message";
  return `HTTP ${status}: ${detail}`.slice(0, 400);
}

/** SQLite's "try again" answers. Miniflare serialises access, so these should not occur; bounded if they do. */
export function isBusy(reason: string): boolean {
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(reason);
}

export interface LocalD1Options {
  /** Defaults to whichever address the dev server answers on (`appOrigin`). */
  readonly origin?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /** How many times a busy database is retried before the call fails. */
  readonly busyRetries?: number;
  readonly pauseMs?: number;
}

export interface LocalD1 {
  /** Runs the statements in order and returns each one's rows. */
  batch(statements: string | readonly string[]): Promise<Row[][]>;
  /** Runs the statements in order and returns every row they produced, flattened. */
  query<T = Row>(statements: string | readonly string[]): Promise<T[]>;
}

export function localD1(options: LocalD1Options = {}): LocalD1 {
  const origin = options.origin ?? appOrigin;
  const send = options.fetch ?? fetch;
  const busyRetries = options.busyRetries ?? 5;
  const pauseMs = options.pauseMs ?? 200;
  let databaseUrl: Promise<string> | null = null;

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function readJson(response: Response): Promise<ExplorerAnswer | null> {
    try {
      return (await response.json()) as ExplorerAnswer;
    } catch {
      return null;
    }
  }

  // A dropped connection is retried once. That can repeat an applied
  // statement, which is harmless: the tests' writes are idempotent.
  async function sendOnce(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await send(url, init);
    } catch {
      await pause(pauseMs);
      return send(url, init);
    }
  }

  async function resolveDatabaseUrl(): Promise<string> {
    const base = `${await origin()}${EXPLORER_PATH}`;
    const response = await sendOnce(base);
    const answer = (await readJson(response)) as
      | (ExplorerAnswer & { result?: { name?: string; uuid?: string }[] })
      | null;
    if (!response.ok || answer?.success !== true) {
      throw new Error(
        `local D1: the dev server's explorer did not list its databases (${failureReason(response.status, answer)}); is \`vite dev\` running on this checkout?`,
      );
    }
    const databases = (answer.result ?? []) as { name?: string; uuid?: string }[];
    const database = databases.find((entry) => entry.name === BINDING);
    if (database?.uuid === undefined) {
      throw new Error(
        `local D1: no database bound as ${BINDING}; the explorer lists ${databases.map((entry) => entry.name).join(", ") || "none"}`,
      );
    }
    return `${base}/${encodeURIComponent(database.uuid)}/raw`;
  }

  async function batch(statements: string | readonly string[]): Promise<Row[][]> {
    const list = typeof statements === "string" ? [statements] : [...statements];
    if (list.length === 0) {
      return [];
    }
    for (const statement of list) {
      assertOneStatement(statement);
    }
    databaseUrl ??= resolveDatabaseUrl().catch((error: unknown) => {
      databaseUrl = null;
      throw error;
    });
    const url = await databaseUrl;
    const body = JSON.stringify({ batch: list.map((sql) => ({ sql })) });
    for (let attempt = 0; ; attempt += 1) {
      const response = await sendOnce(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const answer = await readJson(response);
      if (response.ok && answer?.success === true) {
        return rowsOf(answer);
      }
      const reason = failureReason(response.status, answer);
      if (attempt < busyRetries && isBusy(reason)) {
        await pause(pauseMs * (attempt + 1));
        continue;
      }
      throw new Error(`local D1 query failed: ${reason}`);
    }
  }

  return {
    batch,
    async query<T = Row>(statements: string | readonly string[]): Promise<T[]> {
      return (await batch(statements)).flat() as T[];
    },
  };
}

const shared = localD1();

/** The shared helper every test uses. */
export function queryD1<T = Row>(statements: string | readonly string[]): Promise<T[]> {
  return shared.query<T>(statements);
}

export function queryD1Batch(statements: string | readonly string[]): Promise<Row[][]> {
  return shared.batch(statements);
}
