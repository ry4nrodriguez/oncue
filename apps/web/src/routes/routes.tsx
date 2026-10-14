import type { ArtifactRef, EffortLevel } from "@oncue/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  createBrowserRouter,
  matchPath,
  Navigate,
  type RouteObject,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { harnessAsksPermission } from "@/features/approvals/approval-modes";
import { useHomeApprovalMode } from "@/features/approvals/use-home-approval-mode";
import { useIdentity } from "@/features/auth/AuthGate";
import { connectedProvidersOf } from "@/features/harnesses/harness-state";
import { HomeScreen } from "@/features/home/HomeScreen";
import { liveModelConnectionId, useModelChoice } from "@/features/home/model-choice";
import { usePins } from "@/features/home/pins";
import { useSeenRuns } from "@/features/home/seen-runs";
import { endedRunId } from "@/features/home/session-activity";
import {
  applyLocalChanges,
  type SessionListActions,
  SessionListContext,
  settleLocalChanges,
  useSessionList,
  useSessionListActions,
} from "@/features/home/session-list";
import { groupSessions } from "@/features/home/sidebar-groups";
import { ModalConnectionForm } from "@/features/modal-connection/ModalConnectionForm";
import { ModalConnectionScreen } from "@/features/modal-connection/ModalConnectionScreen";
import { AddConnectionForm } from "@/features/model-connections/AddConnectionForm";
import { type BranchChoice, DEFAULT_BRANCH_CHOICE } from "@/features/repositories/BranchPicker";
import { RepositoriesScreen } from "@/features/repositories/RepositoriesScreen";
import { type DisclosureAnswer, DisclosureCard } from "@/features/secrets/DisclosureCard";
import {
  forgetSecretRequests,
  prefetchSecretRequests,
} from "@/features/secrets/secret-requests-cache";
import type { SubmitOptions } from "@/features/session/Composer";
import { SessionScreen } from "@/features/session/SessionScreen";
import { AgentPermissionsSection } from "@/features/settings/AgentPermissionsSection";
import { HarnessesSection } from "@/features/settings/HarnessesSection";
import { ModelProvidersSection } from "@/features/settings/ModelProvidersSection";
import { ProfileSection } from "@/features/settings/ProfileSection";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { SetupScreen } from "@/features/setup/SetupScreen";
import { readModelStepSkipped, writeModelStepSkipped } from "@/features/setup/setup-skip";
import { type SetupScreen as SetupScreenState, setupScreenOf } from "@/features/setup/setup-step";
import type { SecretRequests } from "@/lib/api/secrets";
import {
  archiveSession,
  BRANCH_REFUSAL_COPY,
  createFailureCopy,
  createSession,
  deleteSession,
  type SessionListRow,
  unarchiveSession,
} from "@/lib/api/sessions";
import type { ModelConnectionSummary, RuntimeSummary } from "@/lib/api/setup";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { AppShell, type AppShellOutletContext } from "./AppShell";
import { SessionNotFound } from "./NotFound";

// The repository name comes from the shell's already-loaded rows. A session
// created without a repository has none, and the rail says so.
function SessionRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const sessions = useOutletContext<AppShellOutletContext>();
  // The composer's model control reads the connections `AuthGate` already loaded, as Home's does.
  const { setup, revision, revalidate } = useIdentity();
  const { runChanged } = useSessionListActions();
  const onRunChange = useCallback(
    (run: { readonly runId: string; readonly ended: boolean } | null) => {
      if (sessionId !== undefined) {
        runChanged(sessionId, run);
      }
    },
    [runChanged, sessionId],
  );
  if (sessionId === undefined || sessionId.trim().length === 0) {
    return <SessionNotFound />;
  }
  const row = sessions.find((session) => session.sessionId === sessionId);
  return (
    // Keyed by the session, so switching sessions mounts a fresh screen with a
    // fresh socket and store instead of reusing the previous session's state.
    <SessionScreen
      key={sessionId}
      sessionId={sessionId}
      repository={row?.repositoryFullName ?? "No repository"}
      taskBranch={row?.taskBranch ?? null}
      baseBranch={row?.baseBranch ?? null}
      branchMode={row?.branchMode ?? "new_branch"}
      modelConnections={
        setup.kind === "ready" || setup.kind === "connect_modal"
          ? setup.modelConnections
          : NO_MODEL_CONNECTIONS
      }
      inactiveModelConnections={setup.kind === "ready" ? setup.inactiveModelConnections : undefined}
      // A run that pauses on its key asks for the connections again, since a
      // rejected key or its replacement changes them after the page loaded.
      onRefreshConnections={revalidate}
      connectionsRevision={revision}
      runtimes={setup.kind === "ready" ? (setup.runtimes ?? NO_RUNTIMES) : NO_RUNTIMES}
      catalog={setup.kind === "ready" ? setup.catalog : undefined}
      runtime={row?.runtime ?? null}
      onRunChange={onRunChange}
      archived={row?.state === "archived"}
      title={row?.title ?? "Untitled session"}
    />
  );
}

/** Settings, Harnesses, with the harnesses this deployment enables, from the identity's setup. */
function HarnessesRoute() {
  const { setup } = useIdentity();
  const connections =
    setup.kind === "ready" || setup.kind === "connect_modal" ? setup.modelConnections : [];
  return (
    <HarnessesSection
      enabled={setup.kind === "ready" ? setup.runtimes : undefined}
      connected={connectedProvidersOf(connections)}
    />
  );
}

/**
 * Settings, Model providers. Home and the session screen read the workspace's
 * keys from the identity, so every change made here refreshes it; otherwise
 * Home would go on offering a key that was just revoked or replaced.
 */
function ModelProvidersRoute() {
  const { revalidate } = useIdentity();
  return <ModelProvidersSection onChanged={() => void revalidate()} />;
}

const NO_MODEL_CONNECTIONS: readonly ModelConnectionSummary[] = [];
const NO_RUNTIMES: readonly RuntimeSummary[] = [];

/** One submit, held while the disclosure card is up, so the launch keeps the message and command id the user typed. */
interface PendingSubmit {
  readonly text: string;
  readonly commandId: string;
  readonly modelConnectionId: string | null;
  readonly modelId: string | null;
  readonly effort: EffortLevel | null | undefined;
  readonly repositoryConnectionId: string | undefined;
  /** The branch the session works from, as the picker held it at the send. */
  readonly branch: BranchChoice;
  readonly skipRequiredChecks: boolean;
  /** Composer attachments, uploaded and waiting to be claimed by the new session. */
  readonly attachments: readonly ArtifactRef[];
  /** The harness, when the composer offered a choice of one. */
  readonly runtime: string | undefined;
}

interface PendingDisclosure {
  readonly pending: PendingSubmit;
  readonly requests: Extract<SecretRequests, { kind: "declared" | "invalid" }>;
}

function HomeRoute() {
  const { setup, revalidate, workspaceId } = useIdentity();
  const navigate = useNavigate();

  // The server only charges the connection it is handed (record 15), so the
  // user picks it here and can see it before submitting. With none, the field
  // is omitted and the Worker runs the fake driver.
  const modelConnections = setup.kind === "ready" ? setup.modelConnections : [];
  // While a key that stopped working is on screen, the identity is read again
  // on arrival and on each return to the tab: the key is replaced in Settings
  // or another tab, and the banner must not outlive it.
  useRefreshOnReturn(
    setup.kind === "ready" && (setup.inactiveModelConnections?.length ?? 0) > 0,
    revalidate,
  );
  // The composer opens on the last model chosen in this workspace, else on the
  // oldest key, and never on a connection the list no longer holds.
  const { choice: rememberedModel, choose: rememberModel } = useModelChoice(workspaceId);
  const [chosenModelConnectionId, setChosenModelConnectionId] = useState<string | null>(null);
  const modelConnectionId = liveModelConnectionId(
    modelConnections,
    chosenModelConnectionId,
    rememberedModel?.connectionId ?? null,
  );
  const selectedModelId =
    rememberedModel !== null && rememberedModel.connectionId === modelConnectionId
      ? rememberedModel.modelId
      : null;

  // Starts on the first connected repository; the user can change it before submitting.
  const repositories = setup.kind === "ready" ? setup.repositories : [];
  const [chosenRepositoryId, setChosenRepositoryId] = useState<string | null>(null);
  const repositoryConnectionId = chosenRepositoryId ?? repositories.at(0)?.repositoryConnectionId;
  // The branch belongs to the repository it was chosen in; another repository
  // starts on its default branch.
  const [chosenBranch, setChosenBranch] = useState<{
    readonly repositoryConnectionId: string | undefined;
    readonly choice: BranchChoice;
  } | null>(null);
  const branchChoice =
    chosenBranch !== null && chosenBranch.repositoryConnectionId === repositoryConnectionId
      ? chosenBranch.choice
      : DEFAULT_BRANCH_CHOICE;
  // The harness a new session runs, when the deployment offers more than one.
  const [chosenRuntimeId, setChosenRuntimeId] = useState<string | null>(null);
  // Why the last submit did not start a session, in the Worker's words.
  // Cleared on the next attempt.
  const [notice, setNotice] = useState<string | null>(null);
  // The caller's own session holding a refused branch, linked beside the notice.
  const [noticeSessionId, setNoticeSessionId] = useState<string | null>(null);
  // The notice is about a model key, so it links to where keys are managed.
  const [noticeModelKeys, setNoticeModelKeys] = useState(false);

  // A repository that declares development secrets shows the disclosure card
  // first; the session is created only from its answer (record 08).
  const [disclosure, setDisclosure] = useState<PendingDisclosure | null>(null);
  // The mode the next session starts with; "Allow for this session" rides the create request.
  const approvals = useHomeApprovalMode();

  const launch = useCallback(
    async (pending: PendingSubmit, answer: DisclosureAnswer) => {
      const result = await createSession({
        commandId: pending.commandId,
        text: pending.text,
        modelConnectionId: pending.modelConnectionId ?? undefined,
        modelId: pending.modelId ?? undefined,
        effort: pending.effort,
        repositoryConnectionId: pending.repositoryConnectionId,
        ...(pending.branch.name === null ? {} : { branch: pending.branch.name }),
        ...(pending.branch.mode === "new_branch" ? {} : { branchMode: pending.branch.mode }),
        skipRequiredChecks: pending.skipRequiredChecks,
        attachments: pending.attachments,
        runtime: pending.runtime,
        secrets: answer ?? undefined,
        approvalMode: harnessAsksPermission(pending.runtime ?? null)
          ? approvals.createMode
          : undefined,
      });
      const staleCard =
        result.kind === "base_moved" ||
        (result.kind !== "created" && "error" in result && result.error === "secrets_disclosure");
      if (staleCard && pending.repositoryConnectionId !== undefined) {
        // The card was drawn before the branch moved or the file changed: read
        // it again at the tip and show it, keeping the draft and command id.
        forgetSecretRequests(pending.repositoryConnectionId);
        const requests = await prefetchSecretRequests(
          pending.repositoryConnectionId,
          pending.branch.name,
        );
        if (requests.kind === "declared" || requests.kind === "invalid") {
          setDisclosure({ pending, requests });
          return false;
        }
      }
      if (result.kind !== "created") {
        // The composer keeps both the draft and the command id, so a retry is
        // the same message and reaches the same derived session.
        setNotice(createFailureCopy(result));
        setNoticeSessionId(result.kind === "branch_refused" ? result.sessionId : null);
        setNoticeModelKeys(result.kind === "model_refused");
        if (result.kind === "model_refused") {
          // The list the composer chose from is out of date: a key was revoked,
          // replaced, or refused since it was read. Read it again, so the
          // picker stops offering what the Worker just refused.
          void revalidate();
        }
        return false;
      }
      // Navigate first; the sidebar refetch follows off the critical path.
      navigate(`/sessions/${result.sessionId}`);
      void revalidate();
      return true;
    },
    [revalidate, navigate, approvals.createMode],
  );

  // Read the repository's declaration ahead of the send, at the branch the
  // session would start from, so the card's answer is in hand when the person
  // clicks (secret-requests-cache.ts).
  const startBranch = branchChoice.name;
  useEffect(() => {
    if (repositoryConnectionId !== undefined) {
      void prefetchSecretRequests(repositoryConnectionId, startBranch);
    }
  }, [repositoryConnectionId, startBranch]);

  const onSubmit = useCallback(
    async (
      text: string,
      commandId: string,
      submittedModelConnectionId: string | null,
      options?: SubmitOptions,
    ) => {
      setNotice(null);
      setNoticeSessionId(null);
      setNoticeModelKeys(false);
      setDisclosure(null);
      const pending: PendingSubmit = {
        text,
        commandId,
        modelConnectionId: submittedModelConnectionId,
        modelId: options?.modelId ?? null,
        effort: options?.effort,
        repositoryConnectionId,
        branch: branchChoice,
        skipRequiredChecks: options?.skipRequiredChecks === true,
        attachments: options?.attachments ?? [],
        runtime: options?.runtime,
      };
      if (repositoryConnectionId === undefined) {
        return launch(pending, null);
      }
      if (branchChoice.mode === "existing_branch" && branchChoice.name === null) {
        // Working directly on the default branch is refused; nothing is chosen yet.
        setNotice(BRANCH_REFUSAL_COPY.default);
        return false;
      }
      const requests = await prefetchSecretRequests(repositoryConnectionId, branchChoice.name);
      if (requests.kind === "none") {
        return launch(pending, null);
      }
      if (requests.kind === "branch_missing") {
        setNotice(BRANCH_REFUSAL_COPY.missing);
        return false;
      }
      if (requests.kind === "declared" || requests.kind === "invalid") {
        // Not a failure: the draft stays, and the card asks.
        setDisclosure({ pending, requests });
        return false;
      }
      // An unreadable declaration is never treated as "asks for nothing". A
      // connection GitHub must confirm again says so, since a retry cannot help.
      setNotice(
        createFailureCopy({
          kind: "refused",
          reason: "admission_refused",
          error:
            requests.kind === "reconnect_github"
              ? "github_reverification_required"
              : "secrets_unreadable",
        }),
      );
      return false;
    },
    [launch, repositoryConnectionId, branchChoice],
  );

  const disclosureCard =
    disclosure === null ? null : (
      <DisclosureCard
        repositoryName={
          repositories.find(
            (repository) =>
              repository.repositoryConnectionId === disclosure.pending.repositoryConnectionId,
          )?.fullName ?? "This repository"
        }
        branch={disclosure.pending.branch.name}
        requests={disclosure.requests}
        onCancel={() => setDisclosure(null)}
        onConfirm={(answer) => {
          const { pending } = disclosure;
          setDisclosure(null);
          void launch(pending, answer);
        }}
      />
    );

  return (
    <HomeScreen
      setup={setup}
      onSubmit={onSubmit}
      notice={notice}
      noticeSessionId={noticeSessionId}
      noticeModelKeys={noticeModelKeys}
      aboveComposer={disclosureCard}
      selectedRepositoryId={repositoryConnectionId ?? null}
      onSelectRepository={setChosenRepositoryId}
      branchChoice={branchChoice}
      onSelectBranch={(choice) => setChosenBranch({ repositoryConnectionId, choice })}
      selectedModelConnectionId={modelConnectionId ?? null}
      onSelectModelConnection={setChosenModelConnectionId}
      selectedModelId={selectedModelId}
      onSelectModel={(connectionId, modelId) => {
        setChosenModelConnectionId(connectionId);
        rememberModel(connectionId, modelId);
      }}
      selectedRuntimeId={chosenRuntimeId}
      {...(harnessAsksPermission(chosenRuntimeId)
        ? { approvalMode: approvals.mode, onApprovalModeChange: approvals.change }
        : {})}
      onSelectRuntime={setChosenRuntimeId}
    />
  );
}

/** What `SetupGate` puts in the redirect's history state, typed at both ends. */
type SetupRedirectState = { readonly redirectedFrom: SetupScreenState["kind"] };

// History state survives a reload and a user can push their own, so it is narrowed rather than cast.
function redirectedFromModal(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "redirectedFrom" in state &&
    state.redirectedFrom === "connect_modal"
  );
}

function SetupRoute() {
  const identity = useIdentity();
  const location = useLocation();

  // "Skip for now" cannot navigate to "/", which would bounce off `SetupGate`
  // back here, so it switches to the "shell" perspective, which never offers
  // the optional model step. Stored so a reload or a redirect does not re-ask.
  const [modelStepSkipped, setModelStepSkipped] = useState(readModelStepSkipped);

  // A redirect caused by a missing Modal connection lands on the Modal step,
  // using the same "shell" perspective.
  const perspective =
    modelStepSkipped || redirectedFromModal(location.state) ? "shell" : ("setup" as const);
  const screen = setupScreenOf(identity.setup, perspective);

  if (screen.kind === "home") {
    return <Navigate to="/" replace />;
  }

  return (
    <SetupScreen
      screen={screen}
      onRetry={() => void identity.revalidate()}
      onSkip={() => {
        writeModelStepSkipped();
        setModelStepSkipped(true);
      }}
    >
      {/* The settings forms. Saving refetches the identity, which moves this route to the next step. */}
      {screen.kind === "connect_modal" ? (
        <ModalConnectionForm
          onSaved={() => {
            void identity.revalidate();
          }}
        />
      ) : (
        <AddConnectionForm
          onSaved={() => {
            void identity.revalidate();
          }}
        />
      )}
    </SetupScreen>
  );
}

const NO_SESSIONS: readonly SessionListRow[] = [];

/**
 * Record 13's mandatory setup gate: GitHub and Modal must be connected before
 * Home. The model key does not gate; a user who skipped it is guided from the
 * composer.
 */
function SetupGate({ children }: { children: ReactNode }) {
  const { setup } = useIdentity();

  const screen = setupScreenOf(setup, "shell");
  if (screen.kind !== "home") {
    // The reason travels with the redirect so `SetupRoute` opens on the step that caused it.
    return (
      <Navigate
        to="/setup"
        replace
        state={{ redirectedFrom: screen.kind } satisfies SetupRedirectState}
      />
    );
  }
  return children;
}

/** Why an archive, restore, or delete did not happen, in the menu's words. */
const SESSION_CHANGE_COPY: Record<"denied" | "failed" | "unreachable", string> = {
  denied: "You're signed out, or this session is no longer yours to change. Sign in again.",
  failed: "OnCue couldn't reach this session just now. Try again in a moment.",
  unreachable: "OnCue couldn't reach the server. Check your connection and try again.",
};

// A run change reaches D1 through the object's outbox after the browser hears it, so the list is read a little later.
const RUN_CHANGE_REFRESH_MS = 1000;

function AppShellRoute() {
  const { workspaceId, revision } = useIdentity();
  const { pathname } = useLocation();

  // `revision` increments once per applied `/api/me` response, so a
  // `revalidate()` refetches the sidebar. The identity object is a fresh
  // literal each render and would refetch every time. The rows belong to the
  // workspace, so they stay on screen while a new revision reads them again.
  const { rows: loadedRows, refresh } = useSessionList(workspaceId, `${pathname}#${revision}`);
  const navigate = useNavigate();
  // Deletes, archives, and restores made here show at once, before the next read.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [states, setStates] = useState<ReadonlyMap<string, SessionListRow["state"]>>(
    () => new Map(),
  );
  const rows = useMemo(
    () => applyLocalChanges(loadedRows ?? NO_SESSIONS, removed, states),
    [loadedRows, removed, states],
  );
  useEffect(() => {
    if (loadedRows === null) {
      return;
    }
    // Only the rows are the trigger; the setters keep the current value when nothing lapsed.
    setRemoved((current) => settleLocalChanges(loadedRows, current, new Map()).removed);
    setStates((current) => settleLocalChanges(loadedRows, new Set(), current).states);
  }, [loadedRows]);
  const { pinned, toggle: togglePin } = usePins(workspaceId);
  const { seen, markSeen } = useSeenRuns(workspaceId, loadedRows);
  const openSessionId = matchPath("/sessions/:sessionId", pathname)?.params.sessionId ?? null;
  const groups = useMemo(
    () => groupSessions(rows, { pins: pinned, seen, openSessionId }),
    [rows, pinned, seen, openSessionId],
  );

  // An ended run on the open session counts as seen.
  useEffect(() => {
    const row = rows.find((candidate) => candidate.sessionId === openSessionId);
    const ended = row === undefined ? null : endedRunId(row);
    if (openSessionId !== null && ended !== null) {
      markSeen(openSessionId, ended);
    }
  }, [rows, openSessionId, markSeen]);

  const actions = useMemo<SessionListActions>(
    () => ({
      runChanged(sessionId, run) {
        refresh(RUN_CHANGE_REFRESH_MS);
        if (run?.ended === true) {
          markSeen(sessionId, run.runId);
        }
      },
      async archive(sessionId, cancelOpenRun) {
        const result = await archiveSession(sessionId, cancelOpenRun);
        if (result.kind === "run_open") {
          return { kind: "run_open" };
        }
        if (result.kind !== "changed") {
          return { kind: "error", message: SESSION_CHANGE_COPY[result.kind] };
        }
        setStates((current) => new Map(current).set(sessionId, "archived"));
        refresh();
        return { kind: "done" };
      },
      async unarchive(sessionId) {
        const result = await unarchiveSession(sessionId);
        if (result.kind !== "changed") {
          return SESSION_CHANGE_COPY[result.kind === "run_open" ? "failed" : result.kind];
        }
        setStates((current) => new Map(current).set(sessionId, "active"));
        refresh();
        return null;
      },
      async remove(sessionId) {
        const result = await deleteSession(sessionId);
        if (result.kind !== "deleted") {
          return SESSION_CHANGE_COPY[result.kind];
        }
        setRemoved((current) => new Set(current).add(sessionId));
        if (openSessionId === sessionId) {
          navigate("/", { replace: true });
        }
        refresh();
        return null;
      },
    }),
    [refresh, markSeen, navigate, openSessionId],
  );

  return (
    <SetupGate>
      <SessionListContext value={actions}>
        <AppShell groups={groups} sessions={rows} onTogglePin={togglePin} />
      </SessionListContext>
    </SetupGate>
  );
}

// Library mode: the router is data, so tests can mount any route directly.
export const routes: RouteObject[] = [
  { path: "/setup", element: <SetupRoute /> },
  {
    path: "/",
    element: <AppShellRoute />,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: "sessions/:sessionId", element: <SessionRoute /> },
      // The Worker's GitHub install callback lands here, so this redirect must stay.
      { path: "repositories", element: <Navigate to="/settings/repositories" replace /> },
      // Old path kept as a redirect for existing links.
      { path: "model-connections", element: <Navigate to="/settings/model-providers" replace /> },
      { path: "*", element: <SessionNotFound /> },
    ],
  },
  // Settings sits beside the shell so its section list does not compete with
  // the session sidebar. It keeps the same setup gate.
  {
    path: "/settings",
    element: (
      <SetupGate>
        <SettingsScreen />
      </SetupGate>
    ),
    children: [
      { index: true, element: <Navigate to="/settings/profile" replace /> },
      { path: "profile", element: <ProfileSection /> },
      { path: "repositories", element: <RepositoriesScreen /> },
      { path: "model-providers", element: <ModelProvidersRoute /> },
      { path: "harnesses", element: <HarnessesRoute /> },
      { path: "agent-permissions", element: <AgentPermissionsSection /> },
      { path: "modal", element: <ModalConnectionScreen /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
