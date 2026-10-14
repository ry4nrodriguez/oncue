import { describe, expect, it } from "vitest";
import type {
  GitHubFact,
  InactiveModelConnectionSummary,
  ModalFact,
  ModelConnectionSummary,
  RepositorySummary,
  SetupFacts,
  SetupState,
} from "./derive";
import { deriveSetup } from "./derive";

const MODELS: readonly ModelConnectionSummary[] = [
  {
    modelConnectionId: "mc_1",
    label: "Claude",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    models: [],
  },
];

const REPOS: readonly RepositorySummary[] = [
  { repositoryConnectionId: "rc_1", fullName: "acme/widgets" },
];

interface Case {
  readonly name: string;
  readonly github: GitHubFact;
  readonly modelConnections: readonly ModelConnectionSummary[];
  /** Defaults to connected. */
  readonly modal?: ModalFact;
  readonly expected: SetupState;
}

const CASES: readonly Case[] = [
  {
    name: "none -> connect_github with no install URL yet",
    github: { kind: "none" },
    modelConnections: [],
    expected: { kind: "connect_github", installUrl: null },
  },
  {
    name: "stuck(cancelled) -> github_stuck(cancelled)",
    github: { kind: "stuck", reason: "cancelled" },
    modelConnections: [],
    expected: { kind: "github_stuck", reason: "cancelled" },
  },
  {
    name: "stuck(no_repositories) -> github_stuck(no_repositories)",
    github: { kind: "stuck", reason: "no_repositories" },
    modelConnections: [],
    expected: { kind: "github_stuck", reason: "no_repositories" },
  },
  {
    name: "stuck(pending_approval) -> github_stuck(pending_approval)",
    github: { kind: "stuck", reason: "pending_approval" },
    modelConnections: [],
    expected: { kind: "github_stuck", reason: "pending_approval" },
  },
  {
    name: "installed with zero repositories -> github_stuck(no_repositories), record 13 failure state 2",
    github: { kind: "installed", repositories: [] },
    modelConnections: MODELS,
    expected: { kind: "github_stuck", reason: "no_repositories" },
  },
  {
    name: "installed with repositories and Modal connected -> ready(repositories, models)",
    github: { kind: "installed", repositories: REPOS },
    modelConnections: MODELS,
    expected: { kind: "ready", repositories: REPOS, modelConnections: MODELS },
  },
  {
    name: "installed with repositories and no Modal -> connect_modal(models)",
    github: { kind: "installed", repositories: REPOS },
    modelConnections: MODELS,
    modal: "none",
    expected: { kind: "connect_modal", modelConnections: MODELS },
  },
  {
    name: "connect_modal carries an empty model list too, which is the skippable step",
    github: { kind: "installed", repositories: REPOS },
    modelConnections: [],
    modal: "none",
    expected: { kind: "connect_modal", modelConnections: [] },
  },
  {
    // GitHub is checked first, since the other steps depend on it.
    name: "no GitHub and no Modal -> connect_github, because GitHub is first",
    github: { kind: "none" },
    modelConnections: [],
    modal: "none",
    expected: { kind: "connect_github", installUrl: null },
  },
  {
    name: "no repositories and no Modal -> github_stuck, for the same reason",
    github: { kind: "installed", repositories: [] },
    modelConnections: [],
    modal: "none",
    expected: { kind: "github_stuck", reason: "no_repositories" },
  },
];

const REJECTED: readonly InactiveModelConnectionSummary[] = [
  { modelConnectionId: "mc_bad", provider: "openai", status: "invalid", activeSessions: 2 },
];

describe("deriveSetup", () => {
  it.each(CASES)("$name", ({ github, modelConnections, modal, expected }) => {
    const facts: SetupFacts = { github, modelConnections, modal: modal ?? "connected" };
    expect(deriveSetup(facts)).toEqual(expected);
  });

  it("names a key that stopped working beside the active ones once the workspace is ready", () => {
    expect(
      deriveSetup({
        github: { kind: "installed", repositories: REPOS },
        modelConnections: MODELS,
        inactiveModelConnections: REJECTED,
        modal: "connected",
      }),
    ).toEqual({
      kind: "ready",
      repositories: REPOS,
      modelConnections: MODELS,
      inactiveModelConnections: REJECTED,
    });
  });

  // The usual body is the one every reader already parses.
  it("leaves the field out when no key has stopped working", () => {
    const ready = deriveSetup({
      github: { kind: "installed", repositories: REPOS },
      modelConnections: MODELS,
      inactiveModelConnections: [],
      modal: "connected",
    });
    expect("inactiveModelConnections" in ready).toBe(false);
  });

  // Home is not reachable before Modal is connected, so nothing reads it there.
  it("does not carry a key that stopped working into an earlier setup step", () => {
    expect(
      deriveSetup({
        github: { kind: "installed", repositories: REPOS },
        modelConnections: [],
        inactiveModelConnections: REJECTED,
        modal: "none",
      }),
    ).toEqual({ kind: "connect_modal", modelConnections: [] });
  });
});
