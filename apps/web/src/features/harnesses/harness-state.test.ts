import { describe, expect, it } from "vitest";
import {
  connectedProvidersOf,
  connectLine,
  harnessForProvider,
  harnessOptions,
  keysLine,
  selectedHarnessOf,
} from "./harness-state";

const ENABLED = [{ id: "opencode" }, { id: "codex" }];

describe("harnessOptions", () => {
  it("lists every harness the image installs in the catalog's order, each in its state", () => {
    const options = harnessOptions(ENABLED, new Set(["anthropic"]));
    expect(options.map((option) => [option.id, option.name, option.state])).toEqual([
      ["opencode", "OpenCode", "ready"],
      ["codex", "Codex", "needs_key"],
    ]);
    expect(options[1]?.providers).toEqual(["openai"]);
  });

  it("never lists a harness the image does not install, even one a Worker says is enabled", () => {
    const options = harnessOptions(
      [{ id: "opencode" }, { id: "pi" }, { id: "claude" }],
      new Set(["anthropic", "openai"]),
    );
    expect(options.map((option) => [option.id, option.state])).toEqual([
      ["opencode", "ready"],
      ["codex", "unavailable"],
    ]);
  });

  it("is ready for a harness once any provider it drives has a key", () => {
    const options = harnessOptions(ENABLED, new Set(["openai"]));
    expect(options.slice(0, 2).map((option) => option.state)).toEqual(["ready", "ready"]);
  });

  it("enables OpenCode alone for an older body that sent no list, and nothing is ready without a key", () => {
    expect(harnessOptions(undefined, new Set()).map((option) => option.state)).toEqual([
      "needs_key",
      "unavailable",
    ]);
  });
});

describe("selectedHarnessOf and harnessForProvider", () => {
  const options = harnessOptions(ENABLED, new Set(["anthropic"]));

  it("keeps the chosen harness while it can run, and otherwise names the first that can", () => {
    expect(selectedHarnessOf(options, "opencode")?.id).toBe("opencode");
    expect(selectedHarnessOf(options, "codex")?.id).toBe("opencode");
    expect(selectedHarnessOf(options, "retired")?.id).toBe("opencode");
    expect(selectedHarnessOf(options, null)?.id).toBe("opencode");
  });

  it("shows a fixed harness as it is, and falls back to the first listed when none can run", () => {
    expect(selectedHarnessOf(options, "codex", true)?.id).toBe("codex");
    const none = harnessOptions(ENABLED, new Set());
    expect(selectedHarnessOf(none, "codex")?.id).toBe("opencode");
    expect(selectedHarnessOf([], null)).toBeNull();
  });

  it("finds the first ready harness for a provider", () => {
    const both = harnessOptions(ENABLED, new Set(["anthropic", "openai"]));
    expect(harnessForProvider(both, "openai")?.id).toBe("opencode");
    // Codex alone enabled, with no OpenAI key: no harness can run an OpenAI model.
    const codexOnly = harnessOptions([{ id: "codex" }], new Set(["anthropic"]));
    expect(harnessForProvider(codexOnly, "openai")).toBeUndefined();
  });
});

describe("the words", () => {
  it("says which keys a harness works with", () => {
    expect(keysLine(["anthropic", "openai"])).toBe("Works with Anthropic and OpenAI keys");
    expect(keysLine(["openai"])).toBe("Works with an OpenAI key");
    expect(keysLine(["anthropic"])).toBe("Works with an Anthropic key");
    expect(keysLine([])).toBe("Works with no provider OnCue connects");
  });

  it("says which key to connect", () => {
    expect(connectLine(["openai"])).toBe("Connect an OpenAI key");
    expect(connectLine(["anthropic"])).toBe("Connect an Anthropic key");
    expect(connectLine(["anthropic", "openai"])).toBe("Connect an Anthropic or OpenAI key");
    expect(connectLine([])).toBe("Connect a key");
  });

  it("reads the providers with a key from the connections, skipping one that names none", () => {
    expect(
      [...connectedProvidersOf([{ provider: "openai" }, {}, { provider: "openai" }])].sort(),
    ).toEqual(["openai"]);
  });
});
