// @vitest-environment node
/**
 * The tests' reset reads the tables that hang off a repository connection from
 * the schema, so a new migration is covered without editing a list. Runs on
 * Node's SQLite with every migration applied and foreign keys enforced, as D1
 * enforces them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cascadeDelete,
  cascadeDeleteStatements,
  type ForeignKey,
  readForeignKeys,
} from "./cascade-delete";
import type { Row } from "./local-d1";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(`${MIGRATIONS}/${file}`, "utf8"));
  }
  // The fixtures below fill columns generically; the CHECK constraints are
  // about product values and have nothing to say about deletion order.
  db.exec("PRAGMA ignore_check_constraints = ON");
  return db;
}

function batchOver(db: DatabaseSync) {
  return async (statements: readonly string[]): Promise<Row[][]> =>
    statements.map((sql) => db.prepare(sql).all() as Row[]);
}

let counter = 0;

/** One row with every required column filled, and the given values on top. */
function insertRow(db: DatabaseSync, table: string, values: Record<string, string | null>): void {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const row: Record<string, string | number | null> = {};
  for (const column of columns) {
    if (column.name in values) {
      row[column.name] = values[column.name] ?? null;
    } else if ((column.notnull === 1 && column.dflt_value === null) || column.pk > 0) {
      counter += 1;
      row[column.name] = column.type.toUpperCase().includes("INT")
        ? counter
        : `${column.name}_${counter}`;
    }
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}

function count(db: DatabaseSync, table: string, where = "1 = 1"): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get() as Row).n);
}

/** A workspace with a repository, a session on it, and a session on no repository. */
function seedWorkspace(db: DatabaseSync): void {
  insertRow(db, "user", { id: "u1" });
  insertRow(db, "workspace", { id: "w1", owner_user_id: "u1" });
  insertRow(db, "github_installation", { installation_row_id: "gi1", workspace_id: "w1" });
  insertRow(db, "repository_connection", {
    repository_connection_id: "rc1",
    workspace_id: "w1",
    installation_row_id: "gi1",
  });
  insertRow(db, "session_index", {
    session_id: "with_repo",
    workspace_id: "w1",
    task_id: null,
    repository_connection_id: "rc1",
  });
  insertRow(db, "session_index", {
    session_id: "no_repo",
    workspace_id: "w1",
    task_id: null,
    repository_connection_id: null,
  });
  insertRow(db, "projection_cursor", { session_id: "with_repo" });
  insertRow(db, "projection_cursor", { session_id: "no_repo" });
  insertRow(db, "deletion_request", { session_id: "with_repo" });
  insertRow(db, "development_secret", { workspace_id: "w1", repository_connection_id: "rc1" });
  insertRow(db, "development_secret_superseded", {
    workspace_id: "w1",
    repository_connection_id: "rc1",
  });
  insertRow(db, "repository_secret_disclosure", {
    repository_connection_id: "rc1",
    workspace_id: "w1",
  });
}

describe("cascade delete over the real migrations", () => {
  it("clears an installation and everything under it, and spares the session on no repository", async () => {
    const db = migratedDatabase();
    seedWorkspace(db);

    await cascadeDelete([{ table: "github_installation" }], batchOver(db));

    for (const table of [
      "github_installation",
      "repository_connection",
      "development_secret",
      "development_secret_superseded",
      "repository_secret_disclosure",
    ]) {
      expect(count(db, table), table).toBe(0);
    }
    // A deletion receipt keeps no key to the index row, so it outlives it.
    expect(count(db, "deletion_request")).toBe(1);
    expect(count(db, "session_index", "session_id = 'with_repo'")).toBe(0);
    expect(count(db, "projection_cursor", "session_id = 'with_repo'")).toBe(0);
    expect(count(db, "session_index", "session_id = 'no_repo'")).toBe(1);
    expect(count(db, "projection_cursor", "session_id = 'no_repo'")).toBe(1);
    expect(count(db, "workspace")).toBe(1);
  });

  it("covers a table a later migration adds, with no list to edit", async () => {
    const db = migratedDatabase();
    db.exec(
      `CREATE TABLE future_child (id TEXT PRIMARY KEY, repository_connection_id TEXT NOT NULL REFERENCES repository_connection (repository_connection_id));
       CREATE TABLE future_grandchild (id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES future_child);`,
    );
    seedWorkspace(db);
    insertRow(db, "future_child", { id: "f1", repository_connection_id: "rc1" });
    insertRow(db, "future_grandchild", { id: "g1", child_id: "f1" });

    await cascadeDelete([{ table: "github_installation" }], batchOver(db));

    expect(count(db, "future_grandchild")).toBe(0);
    expect(count(db, "future_child")).toBe(0);
    expect(count(db, "repository_connection")).toBe(0);
  });

  it("scopes a reset to one workspace and leaves another workspace's rows alone", async () => {
    const db = migratedDatabase();
    seedWorkspace(db);
    insertRow(db, "workspace", { id: "w2", owner_user_id: "u1" });
    insertRow(db, "github_installation", { installation_row_id: "gi2", workspace_id: "w2" });
    insertRow(db, "repository_connection", {
      repository_connection_id: "rc2",
      workspace_id: "w2",
      installation_row_id: "gi2",
    });
    insertRow(db, "development_secret", { workspace_id: "w2", repository_connection_id: "rc2" });

    await cascadeDelete(
      [
        { table: "github_installation", where: "workspace_id = 'w1'" },
        { table: "session_index", where: "workspace_id = 'w1'" },
      ],
      batchOver(db),
    );

    expect(count(db, "session_index")).toBe(0);
    expect(count(db, "projection_cursor")).toBe(0);
    expect(count(db, "repository_connection")).toBe(1);
    expect(count(db, "development_secret", "repository_connection_id = 'rc2'")).toBe(1);
  });

  it("reads every foreign key the migrations declare, with the referenced column named", async () => {
    const keys = await readForeignKeys(batchOver(migratedDatabase()));

    expect(keys).toContainEqual({
      child: "development_secret_superseded",
      column: "repository_connection_id",
      parent: "repository_connection",
      parentColumn: "repository_connection_id",
    });
    expect(keys).toContainEqual({
      child: "projection_cursor",
      column: "session_id",
      parent: "session_index",
      parentColumn: "session_id",
    });
    expect(keys.every((key) => key.parentColumn.length > 0)).toBe(true);
  });
});

describe("readForeignKeys", () => {
  it("resolves a reference that names no column to the parent's primary key", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE parent (key TEXT PRIMARY KEY); CREATE TABLE child (id TEXT, parent_key TEXT REFERENCES parent)",
    );
    expect(await readForeignKeys(batchOver(db))).toEqual([
      { child: "child", column: "parent_key", parent: "parent", parentColumn: "key" },
    ]);
  });

  it("refuses a composite foreign key", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE parent (a TEXT, b TEXT, PRIMARY KEY (a, b)); CREATE TABLE child (a TEXT, b TEXT, FOREIGN KEY (a, b) REFERENCES parent (a, b))",
    );
    await expect(readForeignKeys(batchOver(db))).rejects.toThrow(/composite/);
  });

  it("refuses an implicit reference to a parent with no single-column primary key", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE parent (a TEXT); CREATE TABLE child (id TEXT, a TEXT REFERENCES parent)");
    await expect(readForeignKeys(batchOver(db))).rejects.toThrow(/primary key/);
  });
});

describe("cascadeDeleteStatements", () => {
  const keys: ForeignKey[] = [
    { child: "b", column: "a_id", parent: "a", parentColumn: "id" },
    { child: "c", column: "b_id", parent: "b", parentColumn: "id" },
    { child: "c", column: "x_id", parent: "x", parentColumn: "id" },
    { child: "unrelated", column: "y_id", parent: "y", parentColumn: "id" },
  ];

  it("deletes children first, every row of an unscoped root", () => {
    expect(cascadeDeleteStatements([{ table: "a" }], keys)).toEqual([
      'DELETE FROM "c" WHERE "b_id" IN (SELECT "id" FROM "b" WHERE "a_id" IS NOT NULL)',
      'DELETE FROM "b" WHERE "a_id" IS NOT NULL',
      'DELETE FROM "a"',
    ]);
  });

  it("carries a root's condition down to its descendants", () => {
    expect(cascadeDeleteStatements([{ table: "a", where: "w = 1" }], keys)).toEqual([
      'DELETE FROM "c" WHERE "b_id" IN (SELECT "id" FROM "b" WHERE "a_id" IN (SELECT "id" FROM "a" WHERE w = 1))',
      'DELETE FROM "b" WHERE "a_id" IN (SELECT "id" FROM "a" WHERE w = 1)',
      'DELETE FROM "a" WHERE w = 1',
    ]);
  });

  it("joins the conditions of a table reached two ways", () => {
    const statements = cascadeDeleteStatements([{ table: "a" }, { table: "x" }], keys);
    expect(statements[0]).toBe(
      'DELETE FROM "c" WHERE ("b_id" IN (SELECT "id" FROM "b" WHERE "a_id" IS NOT NULL)) OR ("x_id" IS NOT NULL)',
    );
    expect(statements).toHaveLength(4);
  });

  it("deletes every row when one of a table's roots is unscoped", () => {
    expect(cascadeDeleteStatements([{ table: "a", where: "w = 1" }, { table: "a" }], [])).toEqual([
      'DELETE FROM "a"',
    ]);
  });

  it("refuses a cycle, a self-reference, and a name that is not a plain identifier", () => {
    expect(() =>
      cascadeDeleteStatements(
        [{ table: "p" }],
        [
          { child: "q", column: "p_id", parent: "p", parentColumn: "id" },
          { child: "p", column: "q_id", parent: "q", parentColumn: "id" },
        ],
      ),
    ).toThrow(/cycle/);
    expect(() =>
      cascadeDeleteStatements(
        [{ table: "p" }],
        [{ child: "p", column: "p_id", parent: "p", parentColumn: "id" }],
      ),
    ).toThrow(/itself/);
    expect(() => cascadeDeleteStatements([{ table: "bad name" }], [])).toThrow(/identifier/);
  });
});
