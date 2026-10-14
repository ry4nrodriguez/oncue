/**
 * The Modal token form, used by the setup step and by Settings. The pair is
 * tested against Modal before it is stored, hence "Test and connect". Both
 * halves are `type="password"` so the secret is never pasted into a visible
 * field by mistake.
 */
import { KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { NEUTRAL_BUTTON_BLOCK } from "@/components/ui/button-classes";
import {
  type ModalConnectionRow,
  type SaveModalConnectionInvalidReason,
  saveModalConnection,
} from "@/lib/api/modal-connection";
import { cn } from "@/lib/utils";
import {
  CONNECT_MODAL_POINTS,
  MODAL_FAILURE_MESSAGE,
  MODAL_TOKEN_URL,
} from "./modal-connection-copy";

const FIELD_LABEL = "mt-4 block text-[12px] text-muted-foreground uppercase tracking-wide";

const INVALID_REASON_MESSAGE: Record<SaveModalConnectionInvalidReason, string> = {
  tokenId: "Enter the token ID before connecting.",
  tokenSecret: "Enter the token secret before connecting.",
};

export interface ModalConnectionFormProps {
  readonly primaryLabel?: string;
  readonly onSaved: (connection: ModalConnectionRow) => void;
}

export function ModalConnectionForm({
  primaryLabel = "Test and connect",
  onSaved,
}: ModalConnectionFormProps) {
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [environmentName, setEnvironmentName] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenIdField = useId();
  const tokenSecretField = useId();
  const environmentField = useId();

  async function submit() {
    if (tokenId.trim().length === 0) {
      setError(INVALID_REASON_MESSAGE.tokenId);
      return;
    }
    if (tokenSecret.trim().length === 0) {
      setError(INVALID_REASON_MESSAGE.tokenSecret);
      return;
    }
    setError(null);
    setTesting(true);
    const trimmedEnvironment = environmentName.trim();
    const result = await saveModalConnection({
      tokenId: tokenId.trim(),
      tokenSecret: tokenSecret.trim(),
      environmentName: trimmedEnvironment.length === 0 ? null : trimmedEnvironment,
    });
    setTesting(false);
    // Never hold the pair after the request resolves, win or lose: React
    // state would keep it for every later render.
    setTokenId("");
    setTokenSecret("");
    if (result.kind === "saved") {
      onSaved(result.connection);
      return;
    }
    if (result.kind === "invalid") {
      setError(INVALID_REASON_MESSAGE[result.reason]);
      return;
    }
    if (result.kind === "test_failed") {
      setError(MODAL_FAILURE_MESSAGE[result.reason]);
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
      <ul className="list-disc space-y-1.5 pl-4 text-[12px] text-muted-foreground leading-5">
        {CONNECT_MODAL_POINTS.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>

      <a
        href={MODAL_TOKEN_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-4 inline-block text-[12px] text-text underline underline-offset-2"
      >
        Create a token pair on Modal
      </a>

      <label htmlFor={tokenIdField} className={FIELD_LABEL}>
        Token ID
      </label>
      <div
        className={cn(
          "mt-1.5 flex items-center gap-2 rounded-xl border bg-transparent px-3 py-2.5",
          error !== null ? "border-danger" : "border-border",
        )}
      >
        <KeyRound className="size-4 shrink-0 text-faint" aria-hidden="true" />
        <input
          id={tokenIdField}
          type="password"
          autoComplete="off"
          value={tokenId}
          onChange={(event) => setTokenId(event.target.value)}
          className="w-full bg-transparent font-mono text-[13px] text-text outline-none"
        />
      </div>

      <label htmlFor={tokenSecretField} className={FIELD_LABEL}>
        Token secret
      </label>
      <div
        className={cn(
          "mt-1.5 flex items-center gap-2 rounded-xl border bg-transparent px-3 py-2.5",
          error !== null ? "border-danger" : "border-border",
        )}
      >
        <KeyRound className="size-4 shrink-0 text-faint" aria-hidden="true" />
        <input
          id={tokenSecretField}
          type="password"
          autoComplete="off"
          value={tokenSecret}
          onChange={(event) => setTokenSecret(event.target.value)}
          className="w-full bg-transparent font-mono text-[13px] text-text outline-none"
        />
      </div>

      <label htmlFor={environmentField} className={FIELD_LABEL}>
        Environment (optional)
      </label>
      <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-border px-3 py-2.5">
        <input
          id={environmentField}
          type="text"
          autoComplete="off"
          placeholder="Leave blank for your default"
          value={environmentName}
          onChange={(event) => setEnvironmentName(event.target.value)}
          className="w-full bg-transparent font-mono text-[13px] text-text outline-none placeholder:text-faint"
        />
      </div>

      {error !== null ? (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12px] text-danger leading-5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : (
        <p className="mt-3 flex items-start gap-1.5 text-[12px] text-muted-foreground leading-5">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden="true" />
          Stored encrypted and never shown again. A sandbox never receives it.
        </p>
      )}

      <button type="submit" disabled={testing} className={cn("mt-4", NEUTRAL_BUTTON_BLOCK)}>
        {testing ? "Testing…" : primaryLabel}
      </button>
    </form>
  );
}
