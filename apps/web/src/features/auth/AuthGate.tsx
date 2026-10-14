/**
 * Wires `useAuth()` and `GET /api/me` into `./gate.ts`'s pure decisions and
 * renders the result. There is no sign-in bypass. Routes below reach the
 * identity through `useIdentity()`.
 */
import { useAuth } from "@clerk/react";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SetupState } from "@/lib/api/setup";
import { BlockedScreen } from "./BlockedScreen";
import {
  decideGateState,
  ME_TIMEOUT_MS,
  type MeResult,
  meRetryDelay,
  parseMeResponse,
} from "./gate";
import { LoadingScreen } from "./LoadingScreen";
import { MeFailedScreen } from "./MeFailedScreen";
import { SignInGate } from "./SignInGate";

export interface AuthGateIdentity {
  readonly userId: string;
  readonly workspaceId: string;
  readonly setup: SetupState;
  /**
   * Increments once per applied `/api/me` response. Depend on this rather
   * than the identity object, which is a fresh literal every render.
   */
  readonly revision: number;
  readonly revalidate: () => Promise<void>;
}

export interface AuthGateProps {
  readonly children: (identity: AuthGateIdentity) => ReactNode;
}

export const IdentityContext = createContext<AuthGateIdentity | null>(null);

export function useIdentity(): AuthGateIdentity {
  const value = use(IdentityContext);
  if (value === null) {
    throw new Error("useIdentity must be used inside AuthGate");
  }
  return value;
}

/**
 * The Clerk half: asks Clerk whether anyone is signed in and hands the answer
 * to `IdentityGate`. Split so the dev entry (`src/dev/app-harness.tsx`) can
 * stand in for Clerk's browser SDK alone and keep the real gate.
 */
export function AuthGate({ children }: AuthGateProps) {
  const { isLoaded, isSignedIn } = useAuth();
  return (
    <IdentityGate isLoaded={isLoaded} isSignedIn={isSignedIn === true}>
      {children}
    </IdentityGate>
  );
}

export interface IdentityGateProps extends AuthGateProps {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
}

export function IdentityGate({ isLoaded, isSignedIn, children }: IdentityGateProps) {
  // The last usable answer. A failed refetch keeps it, so a blip after a save
  // never tears down the signed-in app or an open session's socket.
  const [me, setMe] = useState<MeResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [revision, setRevision] = useState(0);
  // Only the most recently issued fetch may set state, so a stale or post-unmount response is dropped.
  const requestId = useRef(0);
  const failures = useRef(0);
  const retryTimer = useRef<number | undefined>(undefined);

  const fetchMe = useCallback(async (): Promise<void> => {
    const id = ++requestId.current;
    window.clearTimeout(retryTimer.current);
    setInFlight(true);
    let parsed: MeResult | null = null;
    // A stalled request is abandoned, so a retry is never stuck behind it.
    const abort = new AbortController();
    const stall = window.setTimeout(() => abort.abort(), ME_TIMEOUT_MS);
    try {
      const response = await fetch("/api/me", { signal: abort.signal });
      const body: unknown = await response.json().catch(() => null);
      parsed = parseMeResponse(response.status, body);
    } catch {
      // A thrown or abandoned fetch is a failure like any unusable answer.
    } finally {
      window.clearTimeout(stall);
    }
    if (requestId.current !== id) {
      return;
    }
    setInFlight(false);
    if (parsed !== null) {
      failures.current = 0;
      setFailed(false);
      setMe(parsed);
      setRevision((current) => current + 1);
      return;
    }
    failures.current += 1;
    setFailed(true);
    retryTimer.current = window.setTimeout(() => void fetchMe(), meRetryDelay(failures.current));
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setMe(null);
      setFailed(false);
      return;
    }
    void fetchMe();
    return () => {
      // Drops the answer in flight and any retry scheduled for this sign-in.
      requestId.current += 1;
      failures.current = 0;
      window.clearTimeout(retryTimer.current);
    };
  }, [isLoaded, isSignedIn, fetchMe]);

  const revalidate = useCallback(() => fetchMe(), [fetchMe]);

  const state = decideGateState(isLoaded, isSignedIn, me, failed);

  if (state.kind === "failed") {
    return <MeFailedScreen retrying={inFlight} onRetry={() => void fetchMe()} />;
  }
  if (state.kind === "loading") {
    return <LoadingScreen />;
  }
  if (state.kind === "signed_out") {
    return <SignInGate />;
  }
  if (state.kind === "blocked") {
    return <BlockedScreen clerkSubject={state.clerkSubject} />;
  }
  const identity: AuthGateIdentity = {
    userId: state.userId,
    workspaceId: state.workspaceId,
    setup: state.setup,
    revision,
    revalidate,
  };
  return <IdentityContext value={identity}>{children(identity)}</IdentityContext>;
}
