/**
 * Settings, Model providers: one card per provider, with or without a key
 * (one key per provider, record 06). Replace keeps the connection id, so
 * sessions continue on the new key. Re-check asks the provider about the
 * stored key now, which is how a key marked invalid by mistake comes back.
 * Revoke destroys the sealed value; the dialog first says how many active
 * sessions still charge it, since those pause at their next model request
 * (record 15). Each card lists the provider's catalog with prices, greyed
 * when no key is connected.
 */
import { KeyRound, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { DANGER_ACTION, GROUP, NEUTRAL_BUTTON, ROW_ACTION } from "@/components/ui/button-classes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddConnectionForm } from "@/features/model-connections/AddConnectionForm";
import {
  PROVIDER_LABEL,
  PROVIDER_MARK,
  STATUS_META,
  TONE_TEXT_CLASS,
} from "@/features/model-connections/connection-status";
import {
  formatContext,
  formatEffortLevels,
  formatPrice,
} from "@/features/model-connections/model-format";
import {
  listModelConnections,
  type ModelCatalog,
  type ModelConnectionRow,
  type ModelProvider,
  type RecheckConnectionResult,
  recheckModelConnection,
  revokeModelConnection,
} from "@/lib/api/model-connections";
import type { ModelSpecSummary } from "@/lib/api/setup";
import { cn } from "@/lib/utils";

type LoadStatus = "loading" | "loaded" | "denied" | "unreachable";

/** The order the cards are drawn in, the same as the setup form offers them. */
const PROVIDERS: readonly ModelProvider[] = ["anthropic", "openai"];

interface OpenForm {
  readonly provider: ModelProvider;
  /** `replace` names the connection whose key is being replaced. */
  readonly replace: string | null;
}

// Deterministic (no Intl) so the text does not depend on the test locale.
function formatValidated(lastValidatedAt: string | null): string {
  return lastValidatedAt === null
    ? "not yet validated"
    : `validated ${lastValidatedAt.slice(0, 10)}`;
}

function sessionsSentence(count: number): string {
  if (count === 0) {
    return "No active session is using this key.";
  }
  const sessions = count === 1 ? "1 active session is" : `${count} active sessions are`;
  return `${sessions} using this key. Each pauses at its next model request until you connect a working key and start a new session.`;
}

/** What a re-check found, in the card's words. Only a rejection is bad news about the key. */
function recheckSentence(
  result: RecheckConnectionResult,
  label: string,
): { readonly text: string; readonly bad: boolean } {
  switch (result.kind) {
    case "checked":
      if (result.check === "accepted") {
        return { text: `${label} accepted this key.`, bad: false };
      }
      if (result.check === "rejected") {
        return {
          text: `${label} rejected this key. Replace it to keep using these models.`,
          bad: true,
        };
      }
      return {
        text: `OnCue couldn't reach ${label}, so nothing changed. Try again in a moment.`,
        bad: false,
      };
    case "revoked":
    case "not_found":
      return { text: "This key is no longer connected. Reload to see your keys.", bad: true };
    case "denied":
      return { text: "You're signed out. Sign in again to check this key.", bad: true };
    case "failed":
    case "unreachable":
      return { text: "OnCue couldn't check this key. Try again in a moment.", bad: true };
  }
}

/** The status as a plain word in its tone: "Active" in green, nothing around it. */
function StatusWord({ status }: { status: ModelConnectionRow["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span className={cn("shrink-0 text-[12px]", TONE_TEXT_CLASS[meta.tone])}>{meta.label}</span>
  );
}

const ACTION = ROW_ACTION;
const PRIMARY = cn(NEUTRAL_BUTTON, "shrink-0 px-3 py-1.5 text-[12px]");

function ModelRows({
  models,
  connected,
}: {
  models: readonly ModelSpecSummary[];
  connected: boolean;
}) {
  return (
    <ul
      className={cn("divide-y divide-border border-border border-t", !connected && "opacity-55")}
      aria-label="Models"
    >
      {models.map((spec) => (
        <li key={spec.modelId} data-testid={`model-row-${spec.modelId}`} className="px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] text-text">{spec.name}</span>
            {spec.recommended ? (
              <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                Recommended
              </span>
            ) : null}
            {spec.status === "legacy" ? (
              <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] text-faint">
                Legacy
              </span>
            ) : null}
          </span>
          {/* One quiet line of facts, wrapping rather than truncating on a narrow pane. */}
          <p className="mt-0.5 text-[12px] text-muted-foreground leading-5">
            {formatPrice(spec)} · {formatContext(spec.contextWindow)} context ·{" "}
            <span className="text-faint">{formatEffortLevels(spec.effort)}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function ModelProvidersSection({
  onChanged,
}: {
  /** A key was connected, replaced, revoked, or re-checked, so whatever else lists the workspace's keys is stale. */
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [connections, setConnections] = useState<readonly ModelConnectionRow[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [pricesAsOf, setPricesAsOf] = useState<string | null>(null);
  const [form, setForm] = useState<OpenForm | null>(null);
  const [revoking, setRevoking] = useState<ModelConnectionRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeFailed, setRevokeFailed] = useState(false);
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [rechecked, setRechecked] = useState<{
    readonly connectionId: string;
    readonly result: RecheckConnectionResult;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listModelConnections().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.kind === "listed") {
        setConnections(result.connections);
        setCatalog(result.catalog);
        setPricesAsOf(result.pricesAsOf);
        setStatus("loaded");
        return;
      }
      setStatus(result.kind);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved(connection: ModelConnectionRow) {
    setConnections((current) => {
      const replaced = current.some((row) => row.connectionId === connection.connectionId);
      return replaced
        ? current.map((row) =>
            row.connectionId === connection.connectionId
              ? { ...connection, activeSessions: row.activeSessions }
              : row,
          )
        : [connection, ...current];
    });
    setForm(null);
    setRechecked(null);
    onChanged?.();
  }

  async function recheck(connectionId: string) {
    setRechecking(connectionId);
    setRechecked(null);
    const result = await recheckModelConnection(connectionId);
    setRechecking(null);
    setRechecked({ connectionId, result });
    if (result.kind === "checked") {
      const { connection } = result;
      setConnections((current) =>
        current.map((row) =>
          row.connectionId === connectionId
            ? { ...connection, activeSessions: row.activeSessions }
            : row,
        ),
      );
      onChanged?.();
    }
  }

  async function confirmRevoke() {
    if (revoking === null) {
      return;
    }
    setRevokeBusy(true);
    setRevokeFailed(false);
    const result = await revokeModelConnection(revoking.connectionId);
    setRevokeBusy(false);
    if (result.kind === "revoked") {
      setConnections((current) =>
        current.map((row) =>
          row.connectionId === revoking.connectionId ? { ...row, status: "revoked" } : row,
        ),
      );
      setRevoking(null);
      onChanged?.();
      return;
    }
    // The row is still right; only the dialog must stay open.
    setRevokeFailed(true);
  }

  return (
    <div className="h-full overflow-y-auto px-8 pt-12 pb-10">
      <div className="mx-auto max-w-[760px]">
        <h1 className="font-semibold text-[20px] text-text tracking-tight">Model providers</h1>
        <p className="mt-1 text-[14px] text-muted-foreground leading-6">
          Your own provider keys, one per provider. OnCue stores a key encrypted, never shows it
          again, and never sends it to a sandbox. A key unlocks every model listed under it.
        </p>

        {status === "loading" ? (
          <p className="mt-6 text-[13px] text-muted-foreground">Loading providers…</p>
        ) : null}
        {status === "denied" ? (
          <p className="mt-6 text-[13px] text-danger">
            You don't have access to view model providers.
          </p>
        ) : null}
        {status === "unreachable" ? (
          <p className="mt-6 text-[13px] text-danger">
            OnCue couldn't load your providers. Try again in a moment.
          </p>
        ) : null}

        {status === "loaded" && catalog !== null
          ? PROVIDERS.map((provider) => {
              const Mark = PROVIDER_MARK[provider];
              const label = PROVIDER_LABEL[provider];
              // Newest first from the Worker; the first live row is the key.
              const live = connections.filter(
                (row) => row.provider === provider && row.status !== "revoked",
              );
              const key = live[0];
              const extras = live.slice(1);
              const connected = key !== undefined;
              const formOpen = form?.provider === provider ? form : null;
              const checked =
                key !== undefined && rechecked?.connectionId === key.connectionId
                  ? recheckSentence(rechecked.result, label)
                  : null;
              return (
                <section
                  key={provider}
                  data-testid={`provider-card-${provider}`}
                  aria-label={label}
                  className={cn(GROUP, "mt-6")}
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Mark className="h-4 w-auto shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-text">{label}</p>
                      <p
                        className="text-[12px] text-faint"
                        data-testid={`provider-status-${provider}`}
                      >
                        {key === undefined
                          ? "Not connected"
                          : `${key.providerAccountHint ?? "no account hint"} · ${formatValidated(key.lastValidatedAt)}`}
                      </p>
                    </div>
                    {key === undefined ? (
                      <button
                        type="button"
                        onClick={() =>
                          setForm(formOpen === null ? { provider, replace: null } : null)
                        }
                        aria-label={`Connect ${label}`}
                        className={PRIMARY}
                      >
                        {formOpen === null ? (
                          <Plus className="size-3.5" aria-hidden="true" />
                        ) : null}
                        {formOpen === null ? "Connect" : "Cancel"}
                      </button>
                    ) : (
                      <>
                        <StatusWord status={key.status} />
                        <button
                          type="button"
                          onClick={() => void recheck(key.connectionId)}
                          disabled={rechecking !== null}
                          aria-label={`Re-check the ${label} key`}
                          className={ACTION}
                        >
                          {rechecking === key.connectionId ? "Checking…" : "Re-check"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setForm(
                              formOpen === null ? { provider, replace: key.connectionId } : null,
                            )
                          }
                          aria-label={`Replace the ${label} key`}
                          className={cn(ACTION, "flex items-center gap-1.5")}
                        >
                          <RefreshCw className="size-3.5" aria-hidden="true" />
                          {formOpen === null ? "Replace" : "Cancel"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRevokeFailed(false);
                            setRevoking(key);
                          }}
                          aria-label={`Revoke the ${label} key`}
                          className={ACTION}
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </div>

                  {checked === null ? null : (
                    <p
                      role="status"
                      data-testid={`recheck-result-${provider}`}
                      className={cn(
                        "border-border border-t px-4 py-2 text-[12px]",
                        checked.bad ? "text-danger" : "text-muted-foreground",
                      )}
                    >
                      {checked.text}
                    </p>
                  )}

                  {extras.map((row) => (
                    <div
                      key={row.connectionId}
                      className="flex items-center gap-3 border-border border-t px-4 py-2.5"
                    >
                      <KeyRound className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                      <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                        Another {label} key, {row.providerAccountHint ?? "no account hint"} ·{" "}
                        {formatValidated(row.lastValidatedAt)}. One key per provider: revoke one.
                      </p>
                      <StatusWord status={row.status} />
                      <button
                        type="button"
                        onClick={() => {
                          setRevokeFailed(false);
                          setRevoking(row);
                        }}
                        aria-label={`Revoke the ${label} key ${row.providerAccountHint ?? row.connectionId}`}
                        className={ACTION}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}

                  {formOpen === null ? null : (
                    <div className="border-border border-t px-4 py-4">
                      <AddConnectionForm
                        provider={provider}
                        replaceConnectionId={formOpen.replace ?? undefined}
                        primaryLabel={formOpen.replace === null ? "Connect" : "Replace key"}
                        onSaved={handleSaved}
                      />
                    </div>
                  )}

                  {connected ? null : (
                    <p className="border-border border-t px-4 py-2 text-[12px] text-faint">
                      Connect a key to use these models.
                    </p>
                  )}
                  <ModelRows models={catalog[provider]} connected={connected} />
                </section>
              );
            })
          : null}

        {status === "loaded" && pricesAsOf !== null ? (
          <p className="mt-4 text-[12px] text-faint">
            Prices are the providers' list prices per million tokens on {pricesAsOf}. The provider
            bills you directly.
          </p>
        ) : null}
      </div>

      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !revokeBusy) {
            setRevoking(null);
          }
        }}
      >
        <DialogContent data-testid="revoke-dialog" className="max-w-md border-border bg-canvas">
          <DialogTitle className="text-[16px] text-text">
            Revoke the {revoking === null ? "" : PROVIDER_LABEL[revoking.provider]} key?
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-muted-foreground leading-6">
            {revoking === null ? null : sessionsSentence(revoking.activeSessions)} The key is
            destroyed and its models leave the picker. You can connect a new key at any time.
          </DialogDescription>
          {revokeFailed ? (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              That key could not be revoked. It is still active. Try again in a moment.
            </p>
          ) : null}
          <DialogFooter className="mt-5">
            <button
              type="button"
              onClick={() => setRevoking(null)}
              disabled={revokeBusy}
              className={ACTION}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmRevoke()}
              disabled={revokeBusy}
              className={cn(DANGER_ACTION, "px-3 py-1.5 text-[12px]")}
            >
              {revokeBusy ? "Revoking…" : "Revoke key"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
