// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertOneStatement, failureReason, isBusy, localD1, rowsOf } from "./local-d1";

const ORIGIN = "http://dev.test";
const LIST_URL = `${ORIGIN}/cdn-cgi/local/explorer/api/d1/database`;
const RAW_URL = `${LIST_URL}/db-uuid/raw`;

const listed = { success: true, result: [{ name: "DB", uuid: "db-uuid" }] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that answers from a script and records what it was sent. */
function scripted(answers: Array<Response | Error>) {
  const sent: { url: string; body: string | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body as string | undefined });
    const next = answers.shift();
    if (next === undefined) {
      throw new Error("the script ran out of answers");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as typeof fetch;
  const d1 = localD1({ origin: async () => ORIGIN, fetch: fetchImpl, pauseMs: 0 });
  return { d1, sent };
}

const oneResult = {
  success: true,
  result: [{ results: { columns: ["id", "name"], rows: [[1, "a"]] } }],
};

describe("localD1", () => {
  it("finds the database bound as DB once, then sends each statement in one batch", async () => {
    const { d1, sent } = scripted([json(listed), json(oneResult), json(oneResult)]);

    expect(await d1.query(["SELECT id, name FROM t"])).toEqual([{ id: 1, name: "a" }]);
    await d1.query("SELECT id, name FROM t");

    expect(sent.map((call) => call.url)).toEqual([LIST_URL, RAW_URL, RAW_URL]);
    expect(JSON.parse(sent[1]?.body ?? "")).toEqual({ batch: [{ sql: "SELECT id, name FROM t" }] });
  });

  it("returns each statement's rows separately from batch", async () => {
    const { d1 } = scripted([
      json(listed),
      json({
        success: true,
        result: [
          { results: { columns: ["n"], rows: [[1]] } },
          { results: { columns: [], rows: [] } },
        ],
      }),
    ]);
    expect(await d1.batch(["SELECT 1 AS n", "DELETE FROM t"])).toEqual([[{ n: 1 }], []]);
  });

  it("sends nothing for an empty list", async () => {
    const { d1, sent } = scripted([]);
    expect(await d1.batch([])).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("retries a busy database a bounded number of times, then succeeds", async () => {
    const busy = json(
      { success: false, errors: [{ message: "D1_ERROR: database is locked" }] },
      500,
    );
    const { d1, sent } = scripted([json(listed), busy, json(oneResult)]);
    expect(await d1.query("SELECT id, name FROM t")).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  it("gives up on a database that stays busy", async () => {
    const busy = () => json({ success: false, errors: [{ message: "SQLITE_BUSY" }] }, 500);
    const { d1 } = scripted([json(listed), busy(), busy(), busy(), busy(), busy(), busy()]);
    await expect(d1.query("SELECT 1")).rejects.toThrow(
      /local D1 query failed: HTTP 500: SQLITE_BUSY/,
    );
  });

  it("fails at once on a real SQL error and does not echo the statement", async () => {
    const { d1 } = scripted([
      json(listed),
      json({ success: false, errors: [{ message: "D1_ERROR: no such table: t" }] }, 500),
    ]);
    const failure = d1.query("SELECT 'sealed-value' FROM t");
    await expect(failure).rejects.toThrow(/no such table: t/);
    await expect(failure).rejects.not.toThrow(/sealed-value/);
  });

  it("retries a dropped connection once", async () => {
    const { d1, sent } = scripted([json(listed), new Error("ECONNRESET"), json(oneResult)]);
    expect(await d1.query("SELECT id, name FROM t")).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  it("says so when no database is bound as DB, and asks again next time", async () => {
    const { d1, sent } = scripted([
      json({ success: true, result: [{ name: "OTHER", uuid: "x" }] }),
      json(listed),
      json(oneResult),
    ]);
    await expect(d1.query("SELECT 1")).rejects.toThrow(
      /no database bound as DB; the explorer lists OTHER/,
    );
    expect(await d1.query("SELECT id, name FROM t")).toHaveLength(1);
    expect(sent[1]?.url).toBe(LIST_URL);
  });

  it("points at the dev server when the explorer does not answer", async () => {
    const { d1 } = scripted([
      new Response("not found", { status: 404 }),
      new Response("", { status: 404 }),
    ]);
    await expect(d1.query("SELECT 1")).rejects.toThrow(
      /explorer did not list its databases \(HTTP 404/,
    );
  });

  it("refuses a string holding two statements before sending anything", async () => {
    const { d1, sent } = scripted([]);
    await expect(d1.query("DELETE FROM a; DELETE FROM b")).rejects.toThrow(
      /one statement per string/,
    );
    expect(sent).toHaveLength(0);
  });
});

describe("assertOneStatement", () => {
  it("accepts one statement, with or without a trailing semicolon", () => {
    expect(() => assertOneStatement("SELECT 1")).not.toThrow();
    expect(() => assertOneStatement("SELECT 1;  \n")).not.toThrow();
  });

  it("ignores semicolons inside quoted literals and identifiers", () => {
    expect(() => assertOneStatement("SELECT 'a;b', \"c;d\", `e;f` FROM t")).not.toThrow();
    expect(() => assertOneStatement("SELECT 'it''s; fine'")).not.toThrow();
  });

  it("refuses a second statement", () => {
    expect(() => assertOneStatement("SELECT 1; SELECT 2")).toThrow();
  });
});

describe("rowsOf, failureReason, isBusy", () => {
  it("keys rows by column and tolerates a missing result", () => {
    expect(rowsOf({ result: [{ results: { columns: ["a"], rows: [[1], [2]] } }] })).toEqual([
      [{ a: 1 }, { a: 2 }],
    ]);
    expect(rowsOf({ result: null })).toEqual([]);
    expect(rowsOf({ result: [{}] })).toEqual([[]]);
  });

  it("names the status and the errors, and caps the length", () => {
    expect(failureReason(500, { errors: [{ message: "one" }, { message: "two" }, {}] })).toBe(
      "HTTP 500: one | two",
    );
    expect(failureReason(502, null)).toBe("HTTP 502: no error message");
    expect(failureReason(500, { errors: [{ message: "x".repeat(1000) }] }).length).toBe(400);
  });

  it("recognises SQLite's busy and locked answers only", () => {
    expect(isBusy("SQLITE_BUSY")).toBe(true);
    expect(isBusy("SQLITE_LOCKED: x")).toBe(true);
    expect(isBusy("database is locked")).toBe(true);
    expect(isBusy("no such table")).toBe(false);
  });
});
