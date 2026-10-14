import { describe, expect, it } from "vitest";
import { parseSetupState } from "./setup";

describe("parseSetupState", () => {
  it("returns null for a non-object", () => {
    expect(parseSetupState(null)).toBeNull();
    expect(parseSetupState("connect_github")).toBeNull();
    expect(parseSetupState(undefined)).toBeNull();
  });

  it("returns null for an unrecognized kind", () => {
    expect(parseSetupState({ kind: "unknown" })).toBeNull();
  });

  describe("connect_github", () => {
    it("parses a string installUrl", () => {
      expect(
        parseSetupState({ kind: "connect_github", installUrl: "https://github.com/x" }),
      ).toEqual({
        kind: "connect_github",
        installUrl: "https://github.com/x",
      });
    });

    it("parses a null installUrl", () => {
      expect(parseSetupState({ kind: "connect_github", installUrl: null })).toEqual({
        kind: "connect_github",
        installUrl: null,
      });
    });

    it("rejects a non-string, non-null installUrl", () => {
      expect(parseSetupState({ kind: "connect_github", installUrl: 4 })).toBeNull();
    });
  });

  describe("github_stuck", () => {
    it("parses each stuck reason", () => {
      for (const reason of ["cancelled", "no_repositories", "pending_approval"]) {
        expect(parseSetupState({ kind: "github_stuck", reason })).toEqual({
          kind: "github_stuck",
          reason,
        });
      }
    });

    it("rejects an unrecognized reason", () => {
      expect(parseSetupState({ kind: "github_stuck", reason: "expired" })).toBeNull();
    });

    it("rejects a non-string reason", () => {
      expect(parseSetupState({ kind: "github_stuck", reason: 1 })).toBeNull();
    });
  });

  describe("connect_modal", () => {
    it("parses an empty model connection list", () => {
      expect(parseSetupState({ kind: "connect_modal", modelConnections: [] })).toEqual({
        kind: "connect_modal",
        modelConnections: [],
      });
    });

    it("parses a populated model connection list", () => {
      const raw = {
        kind: "connect_modal",
        modelConnections: [{ modelConnectionId: "m1", label: "Anthropic" }],
      };
      expect(parseSetupState(raw)).toEqual(raw);
    });

    it("carries a connection's provider and model id when the Worker sends both", () => {
      const raw = {
        kind: "connect_modal",
        modelConnections: [
          {
            modelConnectionId: "m1",
            label: "anthropic ...4f21",
            provider: "anthropic",
            modelId: "claude-sonnet-4-5-20250929",
          },
        ],
      };
      expect(parseSetupState(raw)).toEqual(raw);
    });

    it("drops a provider it has no mark for, and a provider without a model id, keeping the label", () => {
      expect(
        parseSetupState({
          kind: "connect_modal",
          modelConnections: [
            { modelConnectionId: "m1", label: "x", provider: "mistral", modelId: "m" },
            { modelConnectionId: "m2", label: "y", provider: "anthropic" },
          ],
        }),
      ).toEqual({
        kind: "connect_modal",
        modelConnections: [
          { modelConnectionId: "m1", label: "x" },
          { modelConnectionId: "m2", label: "y" },
        ],
      });
    });

    it("rejects a non-array modelConnections field", () => {
      expect(parseSetupState({ kind: "connect_modal", modelConnections: "x" })).toBeNull();
    });

    it("rejects a model connection row missing a field", () => {
      expect(
        parseSetupState({ kind: "connect_modal", modelConnections: [{ label: "Anthropic" }] }),
      ).toBeNull();
    });
  });

  describe("ready", () => {
    it("parses empty repositories and model connections", () => {
      expect(parseSetupState({ kind: "ready", repositories: [], modelConnections: [] })).toEqual({
        kind: "ready",
        repositories: [],
        modelConnections: [],
      });
    });

    it("parses the harnesses on offer, dropping a malformed row, and reads an older body as none", () => {
      const opencode = {
        id: "opencode",
        name: "OpenCode",
        providers: ["anthropic", "openai"],
        images: true,
        holdsToolCalls: true,
      };
      expect(
        parseSetupState({
          kind: "ready",
          repositories: [],
          modelConnections: [],
          runtimes: [opencode, { id: "x" }, { ...opencode, providers: [1] }, null],
        }),
      ).toEqual({ kind: "ready", repositories: [], modelConnections: [], runtimes: [opencode] });
      expect(
        parseSetupState({ kind: "ready", repositories: [], modelConnections: [], runtimes: "no" }),
      ).toEqual({ kind: "ready", repositories: [], modelConnections: [] });
    });

    it("parses every provider's catalog, and drops a malformed one whole", () => {
      const sol = {
        modelId: "gpt-6-sol",
        name: "GPT-6 Sol",
        contextWindow: 400_000,
        effort: ["low", "high"],
        defaultEffort: "low",
        price: { inputPerMTok: 2, outputPerMTok: 8 },
        status: "current",
        recommended: true,
      };
      const base = { kind: "ready", repositories: [], modelConnections: [] };
      expect(parseSetupState({ ...base, catalog: { anthropic: [], openai: [sol] } })).toEqual({
        ...base,
        catalog: { anthropic: [], openai: [sol] },
      });
      expect(
        parseSetupState({ ...base, runtimes: [], catalog: { anthropic: [], openai: [sol] } }),
      ).toEqual({ ...base, runtimes: [], catalog: { anthropic: [], openai: [sol] } });
      expect(parseSetupState({ ...base, catalog: { anthropic: [] } })).toEqual(base);
      expect(parseSetupState({ ...base, catalog: { anthropic: [{}], openai: [] } })).toEqual(base);
      expect(parseSetupState({ ...base, catalog: "no" })).toEqual(base);
    });

    it("keeps the cache prices a row carries, and leaves out one that is not a number", () => {
      const priced = {
        modelId: "gpt-6-sol",
        name: "GPT-6 Sol",
        contextWindow: 1_050_000,
        effort: null,
        defaultEffort: null,
        price: {
          inputPerMTok: 2,
          outputPerMTok: 10,
          cacheReadPerMTok: 0.2,
          cacheWritePerMTok: 2.5,
        },
        status: "current",
        recommended: true,
      };
      const odd = { ...priced, price: { ...priced.price, cacheWritePerMTok: "2.5" } };
      const base = { kind: "ready", repositories: [], modelConnections: [] };
      expect(
        parseSetupState({ ...base, catalog: { anthropic: [], openai: [priced, odd] } }),
      ).toEqual({
        ...base,
        catalog: {
          anthropic: [],
          openai: [
            priced,
            { ...priced, price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 } },
          ],
        },
      });
    });

    it("parses populated repositories and model connections", () => {
      const raw = {
        kind: "ready",
        repositories: [{ repositoryConnectionId: "r1", fullName: "oncue/oncue" }],
        modelConnections: [{ modelConnectionId: "m1", label: "Anthropic" }],
      };
      expect(parseSetupState(raw)).toEqual(raw);
    });

    it("rejects a non-array repositories field", () => {
      expect(
        parseSetupState({ kind: "ready", repositories: null, modelConnections: [] }),
      ).toBeNull();
    });

    it("rejects a repository row missing a field", () => {
      expect(
        parseSetupState({
          kind: "ready",
          repositories: [{ repositoryConnectionId: "r1" }],
          modelConnections: [],
        }),
      ).toBeNull();
    });

    it("rejects a non-array modelConnections field", () => {
      expect(
        parseSetupState({ kind: "ready", repositories: [], modelConnections: "x" }),
      ).toBeNull();
    });

    it("rejects a model connection row missing a field", () => {
      expect(
        parseSetupState({
          kind: "ready",
          repositories: [],
          modelConnections: [{ modelConnectionId: "m1" }],
        }),
      ).toBeNull();
    });

    it("rejects a repository row that is not an object", () => {
      expect(
        parseSetupState({ kind: "ready", repositories: ["oops"], modelConnections: [] }),
      ).toBeNull();
    });

    describe("keys that stopped working", () => {
      const ready = { kind: "ready", repositories: [], modelConnections: [] };
      const rejected = {
        modelConnectionId: "mc_bad",
        provider: "openai",
        status: "invalid",
        activeSessions: 2,
      };

      it("parses each one with its provider, status, and session count", () => {
        expect(
          parseSetupState({
            ...ready,
            inactiveModelConnections: [
              rejected,
              { ...rejected, modelConnectionId: "mc_old", status: "expired", activeSessions: 0 },
              { ...rejected, modelConnectionId: "mc_att", status: "attention_required" },
            ],
          }),
        ).toEqual({
          ...ready,
          inactiveModelConnections: [
            rejected,
            { ...rejected, modelConnectionId: "mc_old", status: "expired", activeSessions: 0 },
            { ...rejected, modelConnectionId: "mc_att", status: "attention_required" },
          ],
        });
      });

      it("reads a body without the field, or with an empty list, as none", () => {
        expect(parseSetupState(ready)).toEqual(ready);
        expect(parseSetupState({ ...ready, inactiveModelConnections: [] })).toEqual(ready);
        expect(parseSetupState({ ...ready, inactiveModelConnections: "x" })).toEqual(ready);
      });

      // An active or revoked row is not a key to replace, so it is never drawn as one.
      it.each([
        ["a row that is not an object", "oops"],
        ["a row with no id", { ...rejected, modelConnectionId: 7 }],
        ["a provider this build has no mark for", { ...rejected, provider: "mistral" }],
        ["an active key", { ...rejected, status: "active" }],
        ["a revoked key", { ...rejected, status: "revoked" }],
      ])("drops %s and keeps the rest of the body", (_name, row) => {
        expect(parseSetupState({ ...ready, inactiveModelConnections: [row, rejected] })).toEqual({
          ...ready,
          inactiveModelConnections: [rejected],
        });
        expect(parseSetupState({ ...ready, inactiveModelConnections: [row] })).toEqual(ready);
      });

      it.each([
        ["missing", undefined],
        ["a fraction", 1.5],
        ["negative", -1],
        ["text", "2"],
      ])("reads a session count that is %s as zero", (_name, activeSessions) => {
        expect(
          parseSetupState({
            ...ready,
            inactiveModelConnections: [{ ...rejected, activeSessions }],
          }),
        ).toEqual({
          ...ready,
          inactiveModelConnections: [{ ...rejected, activeSessions: 0 }],
        });
      });
    });
  });
});

describe("the catalog on a connection", () => {
  it("parses the rows the Worker sends and drops a malformed one", () => {
    const good = {
      modelId: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      effort: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      price: { inputPerMTok: 4, outputPerMTok: 20 },
      status: "current",
      recommended: true,
    };
    const haiku = {
      ...good,
      modelId: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      effort: null,
      defaultEffort: null,
      recommended: false,
    };
    const parsed = parseSetupState({
      kind: "ready",
      repositories: [],
      modelConnections: [
        {
          modelConnectionId: "m1",
          label: "anthropic ...4f21",
          provider: "anthropic",
          modelId: "claude-opus-5-5",
          models: [good, haiku, { ...good, effort: ["huge"] }, { ...good, price: "cheap" }, "nope"],
        },
      ],
    });
    expect(parsed).toMatchObject({
      kind: "ready",
      modelConnections: [{ models: [good, haiku] }],
    });
  });

  it("carries no catalog when the body has none", () => {
    const parsed = parseSetupState({
      kind: "ready",
      repositories: [],
      modelConnections: [{ modelConnectionId: "m1", label: "anthropic ...4f21" }],
    });
    expect(parsed).toEqual({
      kind: "ready",
      repositories: [],
      modelConnections: [{ modelConnectionId: "m1", label: "anthropic ...4f21" }],
    });
  });
});
