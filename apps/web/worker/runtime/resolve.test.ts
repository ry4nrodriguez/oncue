import { RUNTIME_CATALOG } from "@oncue/protocol";
import { describe, expect, it } from "vitest";
import { allowedRuntimes, FAKE_PROVIDER, resolveRuntime, runtimeSummaries } from "./resolve";

const OPENCODE = { id: "opencode", version: RUNTIME_CATALOG.opencode.pinnedVersion } as const;

describe("allowedRuntimes", () => {
  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["only commas and spaces", " , ,"],
  ])("allows OpenCode alone when %s", (_name, allowlist) => {
    expect(allowedRuntimes(allowlist)).toEqual(["opencode"]);
  });

  it("keeps the named ids the image installs, in the catalog's order, and drops the rest", () => {
    expect(allowedRuntimes(" opencode , cursor")).toEqual(["opencode"]);
    expect(allowedRuntimes("cursor")).toEqual([]);
    expect(allowedRuntimes("codex,opencode")).toEqual(["opencode", "codex"]);
    expect(allowedRuntimes("codex")).toEqual(["codex"]);
  });

  it("drops a catalog harness the image does not install, even when the allowlist names it", () => {
    expect(allowedRuntimes("claude")).toEqual([]);
    expect(allowedRuntimes("pi")).toEqual([]);
    expect(allowedRuntimes("pi,claude,codex,opencode")).toEqual(["opencode", "codex"]);
  });
});

describe("resolveRuntime", () => {
  const base = { allowlist: undefined, provider: "anthropic", effort: "low" as const };

  it("resolves the default when the request names none, with the image's pinned version", () => {
    expect(resolveRuntime({ ...base, requested: undefined })).toEqual({
      kind: "resolved",
      runtime: OPENCODE,
    });
    expect(resolveRuntime({ ...base, requested: "opencode", provider: "openai" })).toEqual({
      kind: "resolved",
      runtime: OPENCODE,
    });
  });

  it("refuses what the catalog does not name, whatever shape it came in", () => {
    for (const requested of ["cursor", 7, null, { id: "opencode" }]) {
      expect(resolveRuntime({ ...base, requested })).toMatchObject({
        kind: "refused",
        reason: "unknown_runtime",
      });
    }
  });

  it("refuses a carried harness the operator has not allowed", () => {
    expect(resolveRuntime({ ...base, requested: "opencode", allowlist: "something-else" })).toEqual(
      {
        kind: "refused",
        reason: "not_allowed",
        detail: "OpenCode is not enabled on this OnCue",
      },
    );
  });

  it("refuses a provider the harness cannot drive, and lets the fake driver through", () => {
    expect(resolveRuntime({ ...base, requested: undefined, provider: "gemini" })).toMatchObject({
      kind: "refused",
      reason: "provider_not_supported",
    });
    expect(
      resolveRuntime({ ...base, requested: undefined, provider: FAKE_PROVIDER, effort: null }),
    ).toEqual({ kind: "resolved", runtime: OPENCODE });
  });

  it("checks the effort only when the run names one", () => {
    expect(resolveRuntime({ ...base, requested: undefined, effort: null })).toMatchObject({
      kind: "resolved",
    });
    expect(
      resolveRuntime({ ...base, requested: undefined, effort: "made-up" as "low" }),
    ).toMatchObject({ kind: "refused", reason: "effort_not_supported" });
  });
});

describe("resolveRuntime with Codex", () => {
  const allowlist = "opencode,codex";

  it("runs Codex on an OpenAI model at a level it can send", () => {
    expect(
      resolveRuntime({ requested: "codex", allowlist, provider: "openai", effort: "high" }),
    ).toEqual({
      kind: "resolved",
      runtime: { id: "codex", version: RUNTIME_CATALOG.codex.pinnedVersion },
    });
  });

  it("refuses Codex on an Anthropic model, or while it is not allowed", () => {
    expect(
      resolveRuntime({ requested: "codex", allowlist, provider: "anthropic", effort: null }),
    ).toEqual({
      kind: "refused",
      reason: "provider_not_supported",
      detail: "Codex cannot run this model's provider",
    });
    // GPT-6 documents `max`, and Codex passes OpenAI's word through.
    expect(
      resolveRuntime({ requested: "codex", allowlist, provider: "openai", effort: "max" }),
    ).toMatchObject({ kind: "resolved" });
    expect(
      resolveRuntime({
        requested: "codex",
        allowlist: undefined,
        provider: "openai",
        effort: null,
      }),
    ).toMatchObject({
      kind: "refused",
      reason: "not_allowed",
      detail: "Codex is not enabled on this OnCue",
    });
  });
});

describe("resolveRuntime with a harness the image does not install", () => {
  it.each([
    ["pi", "Pi", "openai", "none"],
    ["claude", "Claude Code", "anthropic", "max"],
  ] as const)(
    "refuses %s whatever the allowlist names, before any other check",
    (requested, name, provider, effort) => {
      const refusal = {
        kind: "refused",
        reason: "not_in_image",
        detail: `${name} is not installed in the sandbox image, so OnCue cannot run it`,
      };
      for (const allowlist of [undefined, "opencode", `opencode,${requested}`, requested]) {
        expect(resolveRuntime({ requested, allowlist, provider, effort })).toEqual(refusal);
      }
      // Refused for the image, not for a provider or an effort it could not take either.
      expect(
        resolveRuntime({
          requested,
          allowlist: requested,
          provider: "gemini",
          effort: "made-up" as "low",
        }),
      ).toEqual(refusal);
    },
  );
});

describe("runtimeSummaries", () => {
  it("offers what is allowed, with no more than the composer needs", () => {
    expect(runtimeSummaries(undefined)).toEqual([
      {
        id: "opencode",
        name: "OpenCode",
        providers: ["anthropic", "openai"],
        images: true,
        holdsToolCalls: true,
      },
    ]);
    expect(runtimeSummaries("cursor")).toEqual([]);
    expect(runtimeSummaries("claude,pi").map((runtime) => runtime.id)).toEqual([]);
  });
});
