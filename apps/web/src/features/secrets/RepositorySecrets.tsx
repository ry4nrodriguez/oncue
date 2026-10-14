/**
 * One repository's development secrets, in Settings (record 08). A value is
 * cleared from this component as the request leaves and the server never
 * returns it, so a saved secret can be replaced or removed but never read.
 */

import { KeyRound, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { deleteSecret, listSecrets, type SecretSummary, saveSecret } from "@/lib/api/secrets";
import { forgetSecretRequests } from "./secret-requests-cache";

/** The server's reasons, in words. Anything it adds later reads as the last line. */
const REFUSALS: Readonly<Record<string, string>> = {
  name_malformed:
    "A name is capital letters, digits, and underscores, starts with a letter, and is at most 64 characters.",
  name_reserved: "That name is reserved: it would change how the sandbox itself runs.",
  name_platform_credential:
    "That is a platform credential. OnCue supplies model and GitHub access itself and never puts those keys in a sandbox.",
  value_too_short:
    "A value needs at least 8 characters, so it can be redacted if it shows up in output.",
  value_too_long: "That value is too large.",
  value_control_character: "A value cannot contain a line break.",
  value_missing: "Enter a value.",
};

const FIELD =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-[13px] text-text outline-none focus-visible:border-text";

export function RepositorySecrets({
  repositoryConnectionId,
  repositoryName,
}: {
  repositoryConnectionId: string;
  repositoryName: string;
}) {
  const nameId = useId();
  const valueId = useId();
  const errorId = useId();
  const [secrets, setSecrets] = useState<readonly SecretSummary[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await listSecrets(repositoryConnectionId);
    if (result.kind === "listed") {
      setSecrets(result.secrets);
    } else {
      setError("The saved secrets could not be read. Try again.");
    }
  }, [repositoryConnectionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // A paste often ends in a line break the user never typed.
    const sending = value.replace(/[\r\n]+$/, "");
    const savingAs = name.trim();
    // Cleared before the request leaves, whatever comes back.
    setValue("");
    setBusy(true);
    setError(null);
    const result = await saveSecret(repositoryConnectionId, savingAs, sending);
    setBusy(false);
    if (result.kind === "saved") {
      setName("");
      // What a session can be asked for changed: the Home prefetch is stale.
      forgetSecretRequests(repositoryConnectionId);
      await reload();
      return;
    }
    setError(
      result.kind === "invalid"
        ? (REFUSALS[result.reason] ?? "That could not be saved.")
        : "That could not be saved. Try again.",
    );
  };

  const remove = async (secretName: string) => {
    setBusy(true);
    setError(null);
    const result = await deleteSecret(repositoryConnectionId, secretName);
    setBusy(false);
    if (result.kind !== "deleted" && result.kind !== "not_found") {
      setError("That could not be removed. Try again.");
    } else {
      forgetSecretRequests(repositoryConnectionId);
    }
    await reload();
  };

  return (
    <section
      aria-label={`Development secrets for ${repositoryName}`}
      data-testid="repository-secrets"
      className="border-border border-t bg-canvas px-4 py-3"
    >
      <p className="text-[12px] text-muted-foreground">
        Development and test values only. A session's code and the model provider can read a secret
        it is given, so never save a production credential. A saved value is never shown again.
      </p>

      {secrets !== null && secrets.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {secrets.map((secret) => (
            <li
              key={secret.secretId}
              data-testid="secret-row"
              className="flex items-center gap-2 text-[13px] text-text"
            >
              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{secret.name}</span>
              {secret.status === "unreadable" ? (
                <span className="text-[12px] text-caution">Needs replacing</span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Remove ${secret.name}`}
                onClick={() => void remove(secret.name)}
                className="h-7 px-2 text-muted-foreground"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {secrets !== null && secrets.length === 0 ? (
        <p className="mt-2 text-[12px] text-faint">No secrets saved for this repository.</p>
      ) : null}

      <form
        onSubmit={(event) => void submit(event)}
        className="mt-3 flex flex-wrap items-end gap-2"
      >
        <div className="min-w-[160px] flex-1">
          <label htmlFor={nameId} className="block pb-1 text-[12px] text-muted-foreground">
            Name
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="DATABASE_URL"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={error === null ? undefined : errorId}
            className={`${FIELD} font-mono`}
          />
        </div>
        <div className="min-w-[200px] flex-[2]">
          <label htmlFor={valueId} className="block pb-1 text-[12px] text-muted-foreground">
            Value
          </label>
          <input
            id={valueId}
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            // Keep password managers from saving the value: extensions honour
            // their ignore attributes, and `new-password` would invite the
            // browser's own save prompt.
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            aria-describedby={error === null ? undefined : errorId}
            className={FIELD}
          />
        </div>
        {/* A native button: the shared Button renders `type="button"` and would never submit. */}
        <button
          type="submit"
          disabled={busy || name.trim().length === 0 || value.length === 0}
          className="inline-flex h-8 items-center justify-center rounded-md bg-foreground px-3 font-medium text-[12px] text-background transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        >
          Save
        </button>
      </form>
      {error === null ? null : (
        <p id={errorId} role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
