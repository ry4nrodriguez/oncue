/**
 * Settings, Repositories: record 07's repository connections, as the GitHub
 * installation grants them. Only "Disconnected" gets a badge. Remove hides a
 * repository from OnCue and refuses new sessions on it, without touching the
 * App's access on GitHub; Restore undoes it.
 */
import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { GitHubMark } from "@/components/brand/icons";
import { DANGER_ACTION, GROUP, NEUTRAL_BUTTON, ROW_ACTION } from "@/components/ui/button-classes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { RepositorySecrets } from "@/features/secrets/RepositorySecrets";
import {
  listRepositories,
  type RepositoryRow,
  removeRepository,
  restoreRepository,
} from "@/lib/api/repositories";
import { cn } from "@/lib/utils";
import { GitHubInstallButton } from "./GitHubInstallButton";
import { CONNECT_GITHUB_POINTS, githubCallbackMessage } from "./repository-status";

type LoadStatus = "loading" | "loaded" | "denied" | "unreachable";

/** Where GitHub lists the App's installations, which is where its access is changed. */
export const GITHUB_INSTALLATIONS_URL = "https://github.com/settings/installations";

// `whitespace-nowrap` keeps "Connect GitHub" on one line inside the flex row.
const HEADER_BUTTON = cn(NEUTRAL_BUTTON, "shrink-0 whitespace-nowrap");

export function RepositoriesScreen() {
  // One repository's secrets open at a time, so a value is never typed beside another repository's name.
  const [openSecrets, setOpenSecrets] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [repositories, setRepositories] = useState<readonly RepositoryRow[]>([]);
  const [removing, setRemoving] = useState<RepositoryRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<"remove" | "restore" | null>(null);
  const [searchParams] = useSearchParams();
  const callbackMessage = githubCallbackMessage(searchParams.get("github"));

  useEffect(() => {
    let cancelled = false;
    listRepositories().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.kind === "listed") {
        setRepositories(result.repositories);
        setStatus("loaded");
        return;
      }
      setStatus(result.kind);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function replaceRow(updated: RepositoryRow) {
    setRepositories((current) =>
      current.map((row) =>
        row.repositoryConnectionId === updated.repositoryConnectionId ? updated : row,
      ),
    );
  }

  async function confirmRemove() {
    if (removing === null) {
      return;
    }
    setBusyId(removing.repositoryConnectionId);
    setFailed(null);
    const result = await removeRepository(removing.repositoryConnectionId);
    setBusyId(null);
    if (result.kind === "updated") {
      replaceRow(result.repository);
      setOpenSecrets((current) => (current === removing.repositoryConnectionId ? null : current));
      setRemoving(null);
      return;
    }
    // The row is still right; only the dialog must stay open.
    setFailed("remove");
  }

  async function restore(row: RepositoryRow) {
    setBusyId(row.repositoryConnectionId);
    setFailed(null);
    const result = await restoreRepository(row.repositoryConnectionId);
    setBusyId(null);
    if (result.kind === "updated") {
      replaceRow(result.repository);
      return;
    }
    setFailed("restore");
  }

  const listed = repositories.filter((row) => row.removedAt === null);
  const removed = repositories.filter((row) => row.removedAt !== null);

  return (
    <div className="h-full overflow-y-auto px-8 pt-12 pb-10">
      <div className="mx-auto max-w-[720px]">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="font-semibold text-[20px] text-text tracking-tight">Repositories</h1>
            <p className="mt-1 text-[14px] text-muted-foreground leading-6">
              Repositories the OnCue GitHub App can reach. Which ones it sees is chosen on GitHub,
              not here.
            </p>
          </div>
          <GitHubInstallButton className={HEADER_BUTTON} idleLabel="Connect GitHub" />
        </div>

        {callbackMessage !== null ? (
          <p role="alert" className="mt-4 text-[13px] text-danger">
            {callbackMessage}
          </p>
        ) : null}

        {status === "loading" ? (
          <p className="mt-6 text-[13px] text-muted-foreground">Loading repositories…</p>
        ) : null}
        {status === "denied" ? (
          <p className="mt-6 text-[13px] text-danger">
            You don't have access to view repositories.
          </p>
        ) : null}
        {status === "unreachable" ? (
          <p className="mt-6 text-[13px] text-danger">
            OnCue couldn't load your repositories. Try again in a moment.
          </p>
        ) : null}

        {status === "loaded" && repositories.length === 0 ? (
          <div className="mt-6 rounded-xl border border-border p-6">
            <p className="text-[13px] text-muted-foreground">No repositories are connected yet.</p>
            <dl className="mt-5 space-y-4">
              {CONNECT_GITHUB_POINTS.map((item) => (
                <div key={item.term}>
                  <dt className="font-medium text-[13px] text-text">{item.term}</dt>
                  <dd className="mt-0.5 text-[12px] text-muted-foreground leading-5">
                    {item.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        {status === "loaded" && listed.length > 0 ? (
          <div className={cn(GROUP, "mt-6 divide-y divide-border")}>
            {listed.map((repo) => (
              <div key={repo.repositoryConnectionId} data-testid="repository-row">
                <div
                  className={cn(
                    "flex items-center gap-3 px-4 py-3",
                    repo.status === "disconnected" && "opacity-60",
                  )}
                >
                  <GitHubMark className="h-4 w-auto shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-text">{repo.fullName}</p>
                    <p className="flex items-center gap-1.5 text-[12px] text-faint">
                      <GitBranch className="size-3.5" aria-hidden="true" />
                      {repo.defaultBranch}
                    </p>
                  </div>
                  {repo.status === "disconnected" ? (
                    <span className="shrink-0 text-[12px] text-danger">Disconnected</span>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={openSecrets === repo.repositoryConnectionId}
                      onClick={() =>
                        setOpenSecrets((current) =>
                          current === repo.repositoryConnectionId
                            ? null
                            : repo.repositoryConnectionId,
                        )
                      }
                      className={cn(NEUTRAL_BUTTON, "shrink-0 px-2.5 py-1 text-[12px]")}
                    >
                      Secrets
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setFailed(null);
                      setRemoving(repo);
                    }}
                    aria-label={`Remove ${repo.fullName}`}
                    className={ROW_ACTION}
                  >
                    Remove
                  </button>
                </div>
                {openSecrets === repo.repositoryConnectionId ? (
                  <RepositorySecrets
                    repositoryConnectionId={repo.repositoryConnectionId}
                    repositoryName={repo.fullName}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {status === "loaded" && repositories.length > 0 && listed.length === 0 ? (
          <p className="mt-6 text-[13px] text-muted-foreground">
            Every connected repository is removed. Restore one below to use it again.
          </p>
        ) : null}

        {status === "loaded" && removed.length > 0 ? (
          <section aria-label="Removed repositories" className="mt-8">
            <h2 className="text-[12px] text-faint uppercase tracking-wide">Removed</h2>
            <p className="mt-1 text-[12px] text-muted-foreground leading-5">
              Hidden from OnCue and refused for new sessions. The GitHub App still has access;
              change that on{" "}
              <a
                href={GITHUB_INSTALLATIONS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-text underline underline-offset-2"
              >
                GitHub
              </a>
              .
            </p>
            <div className={cn(GROUP, "mt-3 divide-y divide-border")}>
              {removed.map((repo) => (
                <div
                  key={repo.repositoryConnectionId}
                  data-testid="removed-repository-row"
                  className="flex items-center gap-3 px-4 py-3 opacity-60"
                >
                  <GitHubMark className="h-4 w-auto shrink-0 text-muted-foreground" />
                  <p className="min-w-0 flex-1 truncate text-[13px] text-text">{repo.fullName}</p>
                  <button
                    type="button"
                    onClick={() => void restore(repo)}
                    disabled={busyId === repo.repositoryConnectionId}
                    aria-label={`Restore ${repo.fullName}`}
                    className={ROW_ACTION}
                  >
                    {busyId === repo.repositoryConnectionId ? "Restoring…" : "Restore"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {failed === "restore" ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            That repository could not be restored. Try again in a moment.
          </p>
        ) : null}
      </div>

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && busyId === null) {
            setRemoving(null);
          }
        }}
      >
        <DialogContent data-testid="remove-dialog" className="max-w-md border-border bg-canvas">
          <DialogTitle className="text-[16px] text-text">
            Remove {removing?.fullName ?? ""} from OnCue?
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-muted-foreground leading-6">
            It leaves the composer's list and new sessions on it are refused. Sessions that already
            ran keep their history. The OnCue GitHub App keeps its access on GitHub; change that
            under GitHub's installed apps. You can restore it here at any time.
          </DialogDescription>
          {failed === "remove" ? (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              That repository could not be removed. It is still listed. Try again in a moment.
            </p>
          ) : null}
          <DialogFooter className="mt-5">
            <button
              type="button"
              onClick={() => setRemoving(null)}
              disabled={busyId !== null}
              className={ROW_ACTION}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmRemove()}
              disabled={busyId !== null}
              className={cn(DANGER_ACTION, "px-3 py-1.5 text-[12px]")}
            >
              {busyId !== null ? "Removing…" : "Remove"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
