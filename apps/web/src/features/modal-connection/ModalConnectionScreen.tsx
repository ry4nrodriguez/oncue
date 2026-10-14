/**
 * The settings section for the workspace's single Modal account: the form
 * when nothing is connected, else one row with a disconnect. The row names
 * the Modal workspace Modal reported during the credential test, so the user
 * can check they pasted the right token.
 */
import { useEffect, useState } from "react";
import { ModalMark } from "@/components/brand/icons";
import { GROUP, ROW_ACTION } from "@/components/ui/button-classes";
import { useIdentity } from "@/features/auth/AuthGate";
import { TONE_TEXT_CLASS } from "@/features/status-tone";
import {
  disconnectModalConnection,
  type ModalConnectionRow,
  readModalConnection,
} from "@/lib/api/modal-connection";
import { cn } from "@/lib/utils";
import { ModalConnectionForm } from "./ModalConnectionForm";
import { MODAL_STATUS_META } from "./modal-connection-copy";

type LoadStatus = "loading" | "loaded" | "denied" | "unreachable";

// Deterministic (no Intl) so the text does not depend on the test locale.
function formatValidated(lastValidatedAt: string): string {
  return `checked ${lastValidatedAt.slice(0, 10)}`;
}

/** "Connected" in green, or "Not working" in red: the word alone, nothing around it. */
function StatusWord({ status }: { status: ModalConnectionRow["status"] }) {
  const meta = MODAL_STATUS_META[status];
  return (
    <span className={cn("shrink-0 text-[12px]", TONE_TEXT_CLASS[meta.tone])}>{meta.label}</span>
  );
}

export function ModalConnectionScreen() {
  const { revalidate } = useIdentity();
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [connection, setConnection] = useState<ModalConnectionRow | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectFailed, setDisconnectFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readModalConnection().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.kind === "read") {
        setConnection(result.connection);
        setStatus("loaded");
        return;
      }
      setStatus(result.kind);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function disconnect() {
    setDisconnecting(true);
    setDisconnectFailed(false);
    const result = await disconnectModalConnection();
    setDisconnecting(false);
    if (result.kind === "disconnected") {
      setConnection(null);
      // `SetupGate` reads the cached identity, so refresh it or the tab still
      // says `ready`. The control plane refuses the create regardless.
      void revalidate();
      return;
    }
    // Nothing was updated optimistically; say the disconnect failed so no one
    // believes the credential was withdrawn.
    setDisconnectFailed(true);
  }

  return (
    <div className="h-full overflow-y-auto px-8 pt-12 pb-10">
      <div className="mx-auto max-w-[720px]">
        <h1 className="flex items-center gap-2.5 font-semibold text-[20px] text-text tracking-tight">
          <ModalMark className="h-4 w-auto" />
          Modal
        </h1>
        <p className="mt-1 text-[14px] text-muted-foreground leading-6">
          OnCue runs every session in a sandbox on your own Modal account, so the compute is yours
          and so is the bill. The token is stored encrypted and never shown again.
        </p>

        {status === "loading" ? (
          <p className="mt-6 text-[13px] text-muted-foreground">Loading your Modal connection…</p>
        ) : null}
        {status === "denied" ? (
          <p className="mt-6 text-[13px] text-danger">
            You don't have access to view this connection.
          </p>
        ) : null}
        {status === "unreachable" ? (
          <p className="mt-6 text-[13px] text-danger">
            OnCue couldn't load your Modal connection. Try again in a moment.
          </p>
        ) : null}

        {status === "loaded" && connection !== null ? (
          <div className={cn(GROUP, "mt-6")}>
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-text">{connection.workspaceName}</p>
                <p className="text-[12px] text-faint">
                  {connection.environmentName ?? "default environment"} ·{" "}
                  {formatValidated(connection.lastValidatedAt)}
                </p>
              </div>
              <StatusWord status={connection.status} />
              <button
                type="button"
                onClick={() => void disconnect()}
                disabled={disconnecting}
                aria-label={`Disconnect the Modal workspace ${connection.workspaceName}`}
                className={ROW_ACTION}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        ) : null}

        {status === "loaded" && connection === null ? (
          <div className="mt-6 rounded-xl border border-border p-4">
            <ModalConnectionForm onSaved={setConnection} />
          </div>
        ) : null}

        {disconnectFailed ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            That connection could not be disconnected. It is still in place. Try again in a moment.
          </p>
        ) : null}
      </div>
    </div>
  );
}
