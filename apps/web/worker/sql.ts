// The one place a D1 not-found branch lives, so callers never write their own
// `if (row === null)`.

export type AtMostOne<T> =
  | { readonly kind: "found"; readonly row: T }
  | { readonly kind: "absent" };

export async function atMostOne<T = Record<string, unknown>>(
  statement: D1PreparedStatement,
): Promise<AtMostOne<T>> {
  const row = await statement.first<T>();
  if (row === null) {
    return { kind: "absent" };
  }
  return { kind: "found", row };
}

export async function exactlyOne<T = Record<string, unknown>>(
  statement: D1PreparedStatement,
  notFoundMessage: string,
): Promise<T> {
  const result = await atMostOne<T>(statement);
  if (result.kind === "absent") {
    throw new Error(notFoundMessage);
  }
  return result.row;
}
