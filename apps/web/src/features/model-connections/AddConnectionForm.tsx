// One form used by the setup step and by Settings, Model providers.
import { KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { NEUTRAL_BUTTON_BLOCK } from "@/components/ui/button-classes";
import {
  createModelConnection,
  type ModelConnectionRow,
  type ModelProvider,
  replaceModelConnectionCredential,
} from "@/lib/api/model-connections";
import { cn } from "@/lib/utils";
import { CATEGORY_MESSAGE, PROVIDER_LABEL, PROVIDER_MARK } from "./connection-status";

const PROVIDERS: readonly ModelProvider[] = ["anthropic", "openai"];

// A 422 already has a sentence in `CATEGORY_MESSAGE`; this covers the two 400 reasons.
const INVALID_REASON_MESSAGE: Record<"provider" | "credential", string> = {
  provider: "Choose a provider before saving.",
  credential: "Enter a key before saving.",
};

/** One key per provider (record 06): the page offers Replace on the card that holds it. */
const ALREADY_CONNECTED_MESSAGE =
  "A key for this provider is already connected. Replace it under Settings, Model providers.";

export interface AddConnectionFormProps {
  /** "Save and continue" during setup, "Connect" or "Replace key" from Model providers. */
  readonly primaryLabel?: string;
  /** Fixes the provider and hides the choice, as on a provider's card in Settings. */
  readonly provider?: ModelProvider | undefined;
  /** Replaces this connection's key; the connection id and its sessions survive (record 06). */
  readonly replaceConnectionId?: string | undefined;
  readonly onSaved: (connection: ModelConnectionRow) => void;
}

export function AddConnectionForm({
  primaryLabel = "Save and continue",
  provider: fixedProvider,
  replaceConnectionId,
  onSaved,
}: AddConnectionFormProps) {
  const [chosenProvider, setChosenProvider] = useState<ModelProvider>("anthropic");
  const provider = fixedProvider ?? chosenProvider;
  const [credential, setCredential] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credentialId = useId();

  async function submit() {
    if (credential.trim().length === 0) {
      setError(INVALID_REASON_MESSAGE.credential);
      return;
    }
    setError(null);
    setValidating(true);
    const result =
      replaceConnectionId === undefined
        ? await createModelConnection({ provider, credential })
        : await replaceModelConnectionCredential(replaceConnectionId, credential);
    setValidating(false);
    // Record 06: the key is never held after the request resolves, win or lose.
    setCredential("");
    if (result.kind === "created" || result.kind === "replaced") {
      onSaved(result.connection);
      return;
    }
    if (result.kind === "invalid") {
      setError(INVALID_REASON_MESSAGE[result.reason]);
      return;
    }
    if (result.kind === "already_connected") {
      setError(ALREADY_CONNECTED_MESSAGE);
      return;
    }
    if (result.kind === "not_found") {
      setError("That connection no longer exists. Connect the provider again.");
      return;
    }
    if (result.kind === "validation_failed") {
      setError(CATEGORY_MESSAGE[result.category]);
      return;
    }
    setError("OnCue couldn't reach the server. Check your connection and try again.");
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {/* `hidden` as an attribute, not a class: assistive technology and jsdom both honour it. */}
      <fieldset className="grid grid-cols-2 gap-2" hidden={fixedProvider !== undefined}>
        <legend className="sr-only">Provider</legend>
        {PROVIDERS.map((option) => {
          const Mark = PROVIDER_MARK[option];
          return (
            <label
              key={option}
              className={cn(
                "flex cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[14px] transition-colors",
                provider === option
                  ? "border-text text-text"
                  : "border-border text-muted-foreground hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name="provider"
                value={option}
                checked={provider === option}
                onChange={() => setChosenProvider(option)}
                className="sr-only"
              />
              <Mark className="h-[15px] w-auto shrink-0" />
              {PROVIDER_LABEL[option]}
            </label>
          );
        })}
      </fieldset>

      <label
        htmlFor={credentialId}
        className={cn(
          "block text-[12px] text-muted-foreground uppercase tracking-wide",
          fixedProvider === undefined ? "mt-4" : "mt-0",
        )}
      >
        API key
      </label>
      <div
        className={cn(
          "mt-1.5 flex items-center gap-2 rounded-xl border bg-transparent px-3 py-2.5",
          error !== null ? "border-danger" : "border-border",
        )}
      >
        <KeyRound className="size-4 shrink-0 text-faint" aria-hidden="true" />
        <input
          id={credentialId}
          type="password"
          autoComplete="off"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          className="w-full bg-transparent font-mono text-[13px] text-text outline-none"
        />
      </div>

      {error !== null ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] text-danger leading-5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : (
        <p className="mt-3 flex items-start gap-1.5 text-[12px] text-muted-foreground leading-5">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden="true" />
          Stored encrypted and never shown again. A sandbox never receives it.
        </p>
      )}

      <button type="submit" disabled={validating} className={cn("mt-4", NEUTRAL_BUTTON_BLOCK)}>
        {validating ? "Validating…" : primaryLabel}
      </button>
    </form>
  );
}
