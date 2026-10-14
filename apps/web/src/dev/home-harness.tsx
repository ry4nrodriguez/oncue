/**
 * Renders the real route tree against a stubbed identity so Home, the sidebar,
 * and setup can be driven without Clerk credentials. Only the identity is
 * stubbed: requests go to the real Worker, which answers them 401. Dev only;
 * `scripts/check-no-dev-harness.mjs` fails the build if this enters it.
 */
import { ClerkProvider } from "@clerk/react";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { type AuthGateIdentity, IdentityContext } from "../features/auth/AuthGate";
import type { ModelSpecSummary, SetupState } from "../lib/api/setup";
import { CLERK_APPEARANCE } from "../lib/clerk-appearance";
import { ThemeProvider } from "../lib/theme";
import { routes } from "../routes/routes";
import "../styles/globals.css";

type Fixture =
  | "ready"
  | "both-providers"
  | "key-rejected"
  | "needs-model"
  | "connect-github"
  | "github-stuck"
  | "github-stuck-cancelled"
  | "github-stuck-no-repositories"
  | "connect-modal";

const FIVE_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const HARNESS_ANTHROPIC_MODELS: readonly ModelSpecSummary[] = [
  {
    modelId: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    effort: FIVE_LEVELS,
    defaultEffort: "medium",
    price: { inputPerMTok: 4, outputPerMTok: 20 },
    status: "current",
    recommended: true,
  },
  {
    modelId: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    effort: FIVE_LEVELS,
    defaultEffort: "medium",
    price: { inputPerMTok: 2, outputPerMTok: 10 },
    status: "current",
    recommended: false,
  },
  {
    modelId: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    effort: null,
    defaultEffort: null,
    price: { inputPerMTok: 1, outputPerMTok: 5 },
    status: "current",
    recommended: false,
  },
];

const HARNESS_OPENAI_MODELS: readonly ModelSpecSummary[] = [
  {
    modelId: "gpt-6-sol",
    name: "GPT-6 Sol",
    contextWindow: 400_000,
    effort: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    price: { inputPerMTok: 2, outputPerMTok: 8 },
    status: "current",
    recommended: true,
  },
  {
    modelId: "gpt-6-luna",
    name: "GPT-6 Luna",
    contextWindow: 400_000,
    effort: ["none", "low", "medium", "high"],
    defaultEffort: "low",
    price: { inputPerMTok: 0.25, outputPerMTok: 2 },
    status: "current",
    recommended: false,
  },
];

const SETUP: Record<Fixture, SetupState> = {
  ready: {
    kind: "ready",
    // Several, so the repository picker's scrolling is observable.
    repositories: [
      { repositoryConnectionId: "rc_1", fullName: "acme/oncue" },
      { repositoryConnectionId: "rc_2", fullName: "acme/api" },
      { repositoryConnectionId: "rc_3", fullName: "acme/web" },
      { repositoryConnectionId: "rc_4", fullName: "acme/billing" },
      { repositoryConnectionId: "rc_5", fullName: "acme/docs" },
      { repositoryConnectionId: "rc_6", fullName: "acme/mobile" },
      { repositoryConnectionId: "rc_7", fullName: "acme/infra" },
      { repositoryConnectionId: "rc_8", fullName: "acme/landing-page" },
      { repositoryConnectionId: "rc_9", fullName: "acme/design-system" },
      { repositoryConnectionId: "rc_10", fullName: "acme/website" },
    ],
    // Two connections on one provider, so the picker's per-connection rows are
    // observable. The catalog rows are a hand copy of
    // `worker/broker/providers/catalog.ts`; browser code does not import the Worker.
    modelConnections: [
      {
        modelConnectionId: "mc_1",
        label: "anthropic ...0a1b",
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        models: HARNESS_ANTHROPIC_MODELS,
      },
      {
        modelConnectionId: "mc_2",
        label: "anthropic ...9c3d",
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        models: HARNESS_ANTHROPIC_MODELS,
      },
    ],
    // OpenCode ready, Codex needing a key, and the rest not enabled: all three harness states.
    runtimes: [
      {
        id: "opencode",
        name: "OpenCode",
        providers: ["anthropic", "openai"],
        images: true,
        holdsToolCalls: true,
      },
      { id: "codex", name: "Codex", providers: ["openai"], images: true, holdsToolCalls: true },
    ],
    // Every provider's models, so OpenAI's are listed with a Connect.
    catalog: { anthropic: HARNESS_ANTHROPIC_MODELS, openai: HARNESS_OPENAI_MODELS },
  },
  // A key for each provider, so every model can be chosen: five effort levels,
  // six, four, and a model with none.
  "both-providers": {
    kind: "ready",
    repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/oncue" }],
    modelConnections: [
      {
        modelConnectionId: "mc_1",
        label: "anthropic ...0a1b",
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        models: HARNESS_ANTHROPIC_MODELS,
      },
      {
        modelConnectionId: "mc_3",
        label: "openai ...77e2",
        provider: "openai",
        modelId: "gpt-6-sol",
        models: HARNESS_OPENAI_MODELS,
      },
    ],
    runtimes: [
      {
        id: "opencode",
        name: "OpenCode",
        providers: ["anthropic", "openai"],
        images: true,
        holdsToolCalls: true,
      },
      { id: "codex", name: "Codex", providers: ["openai"], images: true, holdsToolCalls: true },
    ],
    catalog: { anthropic: HARNESS_ANTHROPIC_MODELS, openai: HARNESS_OPENAI_MODELS },
  },
  // An Anthropic key that works and an OpenAI key the provider rejected, with
  // two sessions still on it: the banner, and the picker's Replace rows.
  "key-rejected": {
    kind: "ready",
    repositories: [{ repositoryConnectionId: "rc_1", fullName: "acme/oncue" }],
    modelConnections: [
      {
        modelConnectionId: "mc_1",
        label: "anthropic ...0a1b",
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        models: HARNESS_ANTHROPIC_MODELS,
      },
    ],
    inactiveModelConnections: [
      { modelConnectionId: "mc_3", provider: "openai", status: "invalid", activeSessions: 2 },
    ],
    runtimes: [
      {
        id: "opencode",
        name: "OpenCode",
        providers: ["anthropic", "openai"],
        images: true,
        holdsToolCalls: true,
      },
    ],
    catalog: { anthropic: HARNESS_ANTHROPIC_MODELS, openai: HARNESS_OPENAI_MODELS },
  },
  "needs-model": { kind: "ready", repositories: [], modelConnections: [] },
  "connect-github": { kind: "connect_github", installUrl: null },
  "github-stuck": { kind: "github_stuck", reason: "pending_approval" },
  "github-stuck-cancelled": { kind: "github_stuck", reason: "cancelled" },
  "github-stuck-no-repositories": { kind: "github_stuck", reason: "no_repositories" },
  // With no model connection, `/setup` offers step 2; a redirect from Home for Modal lands on step 3.
  "connect-modal": { kind: "connect_modal", modelConnections: [] },
};

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const fixture = (params.get("fixture") ?? "ready") as Fixture;
  const identity: AuthGateIdentity = {
    userId: "usr_harness",
    workspaceId: "wsp_harness",
    setup: SETUP[fixture] ?? SETUP.ready,
    revision: 1,
    revalidate: async () => {},
  };

  // A memory router, because this harness is not served from the product paths.
  const router = useMemo(
    () => createMemoryRouter(routes, { initialEntries: [params.get("at") ?? "/"] }),
    [params],
  );

  // The setup screens render Clerk's `SignOutButton`, so the provider is real.
  return (
    <ClerkProvider
      publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
      appearance={CLERK_APPEARANCE}
    >
      <ThemeProvider>
        <IdentityContext value={identity}>
          <RouterProvider router={router} />
        </IdentityContext>
      </ThemeProvider>
    </ClerkProvider>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element not found");
}

createRoot(container).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
