// The cost guard for live testing. `ONCUE_MODEL_ALLOWLIST` is a
// comma-separated list of catalog ids a local Worker may start a session on;
// `pnpm dev:live` sets it to `claude-sonnet-4-5-20250929`, and the doubles leave
// it unset. It applies only when the environment is `local`, so a leftover
// value cannot narrow a hosted user's choice. `envName` is a plain string
// because `env.ONCUE_ENV` is typed as the literal "local".

/**
 * The models a session may start on, or `null` when nothing narrows them:
 * a hosted Worker, or a local one with the binding unset or blank.
 */
export function allowedModels(
  envName: string,
  allowlist: string | undefined,
): ReadonlySet<string> | null {
  if (envName !== "local") {
    return null;
  }
  if (allowlist === undefined) {
    return null;
  }
  const ids = allowlist
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) {
    return null;
  }
  return new Set(ids);
}

export function modelAllowed(
  envName: string,
  allowlist: string | undefined,
  modelId: string,
): boolean {
  const allowed = allowedModels(envName, allowlist);
  if (allowed === null) {
    return true;
  }
  return allowed.has(modelId);
}
