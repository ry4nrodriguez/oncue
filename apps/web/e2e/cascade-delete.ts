/**
 * Deletes rows together with every row that references them, reading the
 * referencing tables from the schema so a new migration is covered without
 * editing a list. D1 enforces foreign keys and the migrations declare no
 * `ON DELETE CASCADE`, so children go first. A child row is deleted only when
 * its parent row is, so a scoped reset never reaches other parents' rows.
 */

import type { Row } from "./local-d1";

export interface ForeignKey {
  /** The referencing table and its column. */
  readonly child: string;
  readonly column: string;
  /** The referenced table and its column. */
  readonly parent: string;
  readonly parentColumn: string;
}

export interface DeleteRoot {
  readonly table: string;
  /** A SQL condition over the table's own columns; omitted means every row. */
  readonly where?: string;
}

const EVERY_ROW = Symbol("every row");
type Condition = string | typeof EVERY_ROW;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`cascade delete: "${name}" is not a plain identifier`);
  }
  return `"${name}"`;
}

/**
 * The DELETE statements, children first, that remove the roots' rows and every
 * row that references them, directly or through other deleted rows.
 */
export function cascadeDeleteStatements(
  roots: readonly DeleteRoot[],
  keys: readonly ForeignKey[],
): string[] {
  for (const key of keys) {
    if (key.child === key.parent) {
      throw new Error(`cascade delete: ${key.child} references itself, which this does not handle`);
    }
  }

  const reached = new Set<string>();
  const pending = roots.map((root) => root.table);
  while (pending.length > 0) {
    const table = pending.pop() as string;
    if (reached.has(table)) {
      continue;
    }
    reached.add(table);
    for (const key of keys) {
      if (key.parent === table) {
        pending.push(key.child);
      }
    }
  }

  // Parents before children (Kahn's algorithm), over the reached tables only.
  const edges = keys.filter((key) => reached.has(key.parent) && reached.has(key.child));
  const incoming = new Map([...reached].map((table) => [table, 0]));
  for (const edge of edges) {
    incoming.set(edge.child, (incoming.get(edge.child) ?? 0) + 1);
  }
  const ready = [...reached].filter((table) => incoming.get(table) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift() as string;
    order.push(table);
    for (const edge of edges) {
      if (edge.parent === table) {
        const left = (incoming.get(edge.child) ?? 0) - 1;
        incoming.set(edge.child, left);
        if (left === 0) {
          ready.push(edge.child);
          ready.sort();
        }
      }
    }
  }
  if (order.length !== reached.size) {
    const stuck = [...reached].filter((table) => !order.includes(table)).sort();
    throw new Error(`cascade delete: the foreign keys among ${stuck.join(", ")} form a cycle`);
  }

  const conditions = new Map<string, Condition>();
  for (const table of order) {
    const parts: Condition[] = roots
      .filter((root) => root.table === table)
      .map((root) => root.where ?? EVERY_ROW);
    for (const edge of edges) {
      if (edge.child !== table) {
        continue;
      }
      const parentCondition = conditions.get(edge.parent) as Condition;
      parts.push(
        parentCondition === EVERY_ROW
          ? `${identifier(edge.column)} IS NOT NULL`
          : `${identifier(edge.column)} IN (SELECT ${identifier(edge.parentColumn)} FROM ${identifier(edge.parent)} WHERE ${parentCondition})`,
      );
    }
    conditions.set(
      table,
      parts.includes(EVERY_ROW)
        ? EVERY_ROW
        : parts.length === 1
          ? (parts[0] as string)
          : parts.map((part) => `(${String(part)})`).join(" OR "),
    );
  }

  return [...order].reverse().map((table) => {
    const condition = conditions.get(table) as Condition;
    return condition === EVERY_ROW
      ? `DELETE FROM ${identifier(table)}`
      : `DELETE FROM ${identifier(table)} WHERE ${condition}`;
  });
}

type Batch = (statements: readonly string[]) => Promise<Row[][]>;

/**
 * Every single-column foreign key in the database, read with `PRAGMA
 * foreign_key_list` per table (D1 refuses the `pragma_foreign_key_list()`
 * table function). A key that names no column points at the parent's
 * primary key, which is looked up the same way.
 */
export async function readForeignKeys(batch: Batch): Promise<ForeignKey[]> {
  const [tableRows = []] = await batch([
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name",
  ]);
  const tables = tableRows.map((row) => String(row.name));
  const keyLists = await batch(
    tables.map((table) => `PRAGMA foreign_key_list(${identifier(table)})`),
  );

  const partial = tables.flatMap((child, index) =>
    (keyLists[index] ?? []).map((row) => {
      if (Number(row.seq ?? 0) > 0) {
        throw new Error(
          `cascade delete: ${child} has a composite foreign key, which this does not handle`,
        );
      }
      return {
        child,
        column: String(row.from),
        parent: String(row.table),
        parentColumn: row.to === null || row.to === undefined ? null : String(row.to),
      };
    }),
  );

  const needPrimaryKey = [
    ...new Set(partial.filter((key) => key.parentColumn === null).map((key) => key.parent)),
  ];
  const primaryKeys = new Map<string, string>();
  if (needPrimaryKey.length > 0) {
    const infos = await batch(
      needPrimaryKey.map((table) => `PRAGMA table_info(${identifier(table)})`),
    );
    needPrimaryKey.forEach((table, index) => {
      const columns = (infos[index] ?? []).filter((row) => Number(row.pk) > 0);
      if (columns.length !== 1) {
        throw new Error(`cascade delete: ${table} has no single-column primary key to reference`);
      }
      primaryKeys.set(table, String(columns[0]?.name));
    });
  }

  return partial.map((key) => ({
    ...key,
    parentColumn: key.parentColumn ?? (primaryKeys.get(key.parent) as string),
  }));
}

/** Reads the schema's foreign keys, then deletes the roots and everything that references them. */
export async function cascadeDelete(roots: readonly DeleteRoot[], batch: Batch): Promise<void> {
  await batch(cascadeDeleteStatements(roots, await readForeignKeys(batch)));
}
