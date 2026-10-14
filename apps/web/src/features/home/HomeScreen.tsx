import type { ApprovalMode } from "@oncue/protocol";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { inactiveKeyBanner, REPLACE_KEY } from "@/features/model-connections/inactive-keys";
import {
  type BranchChoice,
  BranchPicker,
  DEFAULT_BRANCH_CHOICE,
} from "@/features/repositories/BranchPicker";
import { Composer, type SubmitOptions } from "@/features/session/Composer";
import { ContextMeterAtRest } from "@/features/session/ContextMeter";
import { MODEL_CONNECTIONS_PATH } from "@/features/session/composer-state";
import { setupScreenOf } from "@/features/setup/setup-step";
import type { InactiveModelConnection, SetupState } from "@/lib/api/setup";
import { AsciiField } from "./AsciiField";

export type HomeScreenProps = {
  setup?: SetupState;
  /** Why the last submit did not start a session, or `null`. Shown under the composer. */
  notice?: string | null;
  /** A session the notice is about, such as the one holding a branch, linked beside it. */
  noticeSessionId?: string | null;
  /** The notice is about a model key, so Settings, Model providers is linked beside it. */
  noticeModelKeys?: boolean;
  /** The disclosure card while a submit waits on its answer, above the composer so the draft stays in view. */
  aboveComposer?: React.ReactNode;
  selectedRepositoryId?: string | null;
  onSelectRepository?: (repositoryConnectionId: string) => void;
  /** The branch the session works from, and how; absent, the default branch and a new task branch. */
  branchChoice?: BranchChoice;
  onSelectBranch?: (choice: BranchChoice) => void;
  /** Which of the workspace's model connections `run.start` will charge. */
  selectedModelConnectionId?: string | null;
  onSelectModelConnection?: (modelConnectionId: string) => void;
  /** The catalog model on it; `null` opens on the connection's recommended row. */
  selectedModelId?: string | null;
  onSelectModel?: (connectionId: string, modelId: string) => void;
  /** The harness a new session runs, when the deployment offers more than one; `null` opens on the first. */
  selectedRuntimeId?: string | null;
  onSelectRuntime?: (runtimeId: string) => void;
  onSubmit?: (
    text: string,
    commandId: string,
    modelConnectionId: string | null,
    options?: SubmitOptions,
  ) => Promise<boolean> | boolean;
  /**
   * The mode the next session starts with (record 09), shown by the picker
   * below the composer; null when the workspace's setting cannot be read.
   */
  approvalMode?: ApprovalMode | null;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
};

const READY_EMPTY: SetupState = { kind: "ready", repositories: [], modelConnections: [] };
const NO_INACTIVE_KEYS: readonly InactiveModelConnection[] = [];

// `connect_modal` is unreachable here (`SetupGate` redirects first) but keeps
// a sentence so a gate change cannot fall through to the wrong instruction.
function guidanceFor(
  kind: "connect_github" | "github_stuck" | "add_model" | "connect_modal",
): string {
  if (kind === "add_model") {
    return "Add a model connection to run this on your own credentials.";
  }
  if (kind === "connect_modal") {
    return "Connect your Modal account so sessions have somewhere to run.";
  }
  return "Connect a repository to run this against real code.";
}

/**
 * Guides the user through missing setup (record 13) without disabling the
 * composer, since the fake driver needs no model. It asks the "setup"
 * perspective, because "shell" reports `home` and would hide the model step.
 */
export function HomeScreen({
  setup = READY_EMPTY,
  onSubmit,
  notice = null,
  noticeSessionId = null,
  noticeModelKeys = false,
  aboveComposer = null,
  selectedRepositoryId = null,
  onSelectRepository,
  branchChoice = DEFAULT_BRANCH_CHOICE,
  onSelectBranch,
  selectedModelConnectionId = null,
  onSelectModelConnection,
  selectedModelId = null,
  onSelectModel,
  selectedRuntimeId = null,
  onSelectRuntime,
  approvalMode,
  onApprovalModeChange,
}: HomeScreenProps) {
  const screen = setupScreenOf(setup, "setup");
  // Keys that stopped working. Each is named above the composer, because the
  // sessions on it are stuck wherever the person happens to be looking.
  const inactiveKeys =
    setup.kind === "ready"
      ? (setup.inactiveModelConnections ?? NO_INACTIVE_KEYS)
      : NO_INACTIVE_KEYS;
  // A workspace whose only key stopped working has a key to replace, not one
  // to add: the setup step would refuse a second key for the same provider.
  const guidance =
    screen.kind === "home" || (screen.kind === "add_model" && inactiveKeys.length > 0)
      ? null
      : screen.kind;
  const bannerCount = inactiveKeys.length;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [wordmarkBottom, setWordmarkBottom] = useState(0);

  // The wordmark sits above the composer, so it is measured rather than
  // guessed, and again when a key banner comes or goes above the composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the banner count is a trigger, not an input.
  useEffect(() => {
    function measure() {
      const node = contentRef.current;
      if (node !== null) {
        setWordmarkBottom(node.getBoundingClientRect().top - 40);
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [bannerCount]);

  return (
    <div
      className="relative flex h-full items-center justify-center px-4 sm:px-8"
      data-testid="home-screen"
    >
      <AsciiField
        className="pointer-events-none absolute inset-0 h-full w-full"
        wordmark
        wordmarkBottom={wordmarkBottom}
      />
      <div ref={contentRef} className="relative z-10 -mt-10 w-full max-w-[660px]">
        {guidance === null ? null : (
          <p className="mb-2.5 px-1 text-[13px] text-muted-foreground" data-testid="home-guidance">
            {guidanceFor(guidance)}{" "}
            <Link to="/setup" className="text-text underline underline-offset-2">
              Finish setup
            </Link>
          </p>
        )}
        {inactiveKeys.map((connection) => (
          <p
            key={connection.modelConnectionId}
            data-testid="home-key-banner"
            data-provider={connection.provider}
            className="mb-2.5 flex items-start gap-2 px-1 text-[13px] text-text"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden="true" />
            <span>
              {inactiveKeyBanner(connection)}{" "}
              <Link
                to={MODEL_CONNECTIONS_PATH}
                data-testid="home-key-banner-link"
                className="text-text underline underline-offset-2"
              >
                {REPLACE_KEY}
              </Link>
            </span>
          </p>
        ))}
        {aboveComposer}
        <div className="relative z-20">
          <Composer
            sessionId="new"
            repositories={setup.kind === "ready" ? setup.repositories : []}
            selectedRepositoryId={selectedRepositoryId}
            branchPicker={
              onSelectBranch === undefined || setup.kind !== "ready" ? null : (
                <BranchPicker
                  repositoryConnectionId={selectedRepositoryId}
                  choice={branchChoice}
                  onChange={onSelectBranch}
                />
              )
            }
            modelConnections={
              setup.kind === "ready" || setup.kind === "connect_modal"
                ? setup.modelConnections.map((connection) => ({
                    id: connection.modelConnectionId,
                    label: connection.label,
                    provider: connection.provider,
                    modelId: connection.modelId,
                    models: connection.models,
                  }))
                : []
            }
            selectedModelConnectionId={selectedModelConnectionId}
            selectedModelId={selectedModelId}
            runtimes={setup.kind === "ready" ? (setup.runtimes ?? []) : []}
            {...(setup.kind === "ready" && setup.catalog !== undefined
              ? { catalog: setup.catalog }
              : {})}
            inactiveKeys={inactiveKeys}
            selectedRuntimeId={selectedRuntimeId}
            {...(onSelectRuntime ? { onSelectRuntime } : {})}
            {...(onSelectRepository ? { onSelectRepository } : {})}
            {...(onSelectModelConnection ? { onSelectModelConnection } : {})}
            {...(onSelectModel ? { onSelectModel } : {})}
            {...(onSubmit ? { onSubmit } : {})}
            // Under the box's bottom-right corner, where a session's gauge sits.
            belowEnd={<ContextMeterAtRest />}
            {...(approvalMode === undefined ? {} : { approvalMode })}
            {...(onApprovalModeChange ? { onApprovalModeChange } : {})}
          />
        </div>
        {notice === null ? null : (
          <p
            role="status"
            data-testid="home-notice"
            className="mt-2.5 flex items-start gap-2 px-1 text-[13px] text-danger"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {notice}
              {noticeSessionId === null ? null : (
                <>
                  {" "}
                  <Link
                    to={`/sessions/${encodeURIComponent(noticeSessionId)}`}
                    data-testid="home-notice-session"
                    className="text-text underline underline-offset-2"
                  >
                    Open that session
                  </Link>
                </>
              )}
              {noticeModelKeys ? (
                <>
                  {" "}
                  <Link
                    to="/settings/model-providers"
                    data-testid="home-notice-model-keys"
                    className="text-text underline underline-offset-2"
                  >
                    Open Model providers
                  </Link>
                </>
              ) : null}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
