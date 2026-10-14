import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessOptions } from "@/features/harnesses/harness-state";
import type { ModelCatalog, ModelSpecSummary, RuntimeSummary } from "@/lib/api/setup";
import { Composer } from "./Composer";
import { FIXED_FOR_SESSION } from "./composer-menu";
import {
  type ModelChoice,
  ModelPicker,
  menuRowsOf,
  modelRowsOf,
  unconnectedRowsOf,
} from "./ModelPicker";
import { RuntimePicker, showsHarnessChoice } from "./RuntimePicker";

function summary(id: string, name: string, providers: readonly string[]): RuntimeSummary {
  return { id, name, providers, images: true, holdsToolCalls: true };
}
const OPENCODE = summary("opencode", "OpenCode", ["anthropic", "openai"]);
const CODEX = summary("codex", "Codex", ["openai"]);

function spec(modelId: string, name: string, recommended = false): ModelSpecSummary {
  return {
    modelId,
    name,
    contextWindow: 200_000,
    effort: ["low", "high"],
    defaultEffort: "low",
    price: { inputPerMTok: 3, outputPerMTok: 15 },
    status: "current",
    recommended,
  };
}
const CATALOG: ModelCatalog = {
  anthropic: [
    spec("claude-sonnet-5", "Claude Sonnet 5", true),
    spec("claude-haiku-4-5", "Claude Haiku 4.5"),
  ],
  openai: [spec("gpt-6-sol", "GPT-6 Sol", true), spec("gpt-6-luna", "GPT-6 Luna")],
};

const ANTHROPIC_KEY: ModelChoice = {
  id: "mc_anthropic",
  label: "anthropic ...0a1b",
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  models: CATALOG.anthropic,
};
const OPENAI_KEY: ModelChoice = {
  id: "mc_openai",
  label: "openai ...9c3d",
  provider: "openai",
  modelId: "gpt-6-sol",
  models: CATALOG.openai,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RuntimePicker", () => {
  // OpenCode and Codex enabled; only an Anthropic key: Codex needs a key.
  const harnesses = harnessOptions([OPENCODE, CODEX], new Set(["anthropic"]));

  it("draws nothing without a list of harnesses", () => {
    const { container } = render(<RuntimePicker harnesses={[]} selectedId={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("draws nothing where only one harness is offered, chosen or fixed: there is no choice to show", () => {
    const one = harnessOptions([OPENCODE], new Set(["anthropic"]));
    expect(showsHarnessChoice(one)).toBe(false);
    const open = render(<RuntimePicker harnesses={one} selectedId="opencode" onSelect={vi.fn()} />);
    expect(open.container.innerHTML).toBe("");
    open.unmount();
    const fixed = render(<RuntimePicker harnesses={one} selectedId="opencode" />);
    expect(fixed.container.innerHTML).toBe("");
  });

  it("lists the harnesses this deployment offers under Run with: the ready one with its check, Connect for a missing key, and none it has not enabled", () => {
    const onSelect = vi.fn();
    expect(showsHarnessChoice(harnesses)).toBe(true);
    render(<RuntimePicker harnesses={harnesses} selectedId="opencode" onSelect={onSelect} />);
    const section = screen.getByRole("group", { name: "Run with" });
    // No subtitle naming providers.
    expect(within(section).queryByText(/Anthropic, OpenAI/)).toBeNull();
    const opencode = within(section).getByRole("button", { name: /OpenCode/ });
    expect(opencode.getAttribute("aria-pressed")).toBe("true");
    expect(opencode.querySelector(".lucide-check")).not.toBeNull();
    const codex = within(section).getByRole("link", { name: "Codex: connect a key" });
    expect(codex.getAttribute("href")).toBe("/settings/harnesses");
    expect(within(codex).getByText("Connect")).toBeTruthy();
    // A harness the deployment has not enabled is left to Settings, so the panel stays short.
    expect(within(section).queryByTestId("harness-row-pi")).toBeNull();
    expect(within(section).queryByTestId("harness-row-claude")).toBeNull();
    expect(section.textContent).toBe("Run withOpenCodeCodexConnect");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("follows Connect through the router where there is one", () => {
    render(
      <MemoryRouter>
        <RuntimePicker harnesses={harnesses} selectedId="opencode" onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Codex: connect a key" }).getAttribute("href")).toBe(
      "/settings/harnesses",
    );
  });

  it("reports the harness the person picks, and checks only the chosen one", () => {
    const onSelect = vi.fn();
    const both = harnessOptions([OPENCODE, CODEX], new Set(["anthropic", "openai"]));
    render(<RuntimePicker harnesses={both} selectedId="opencode" onSelect={onSelect} />);
    const codex = screen.getByRole("button", { name: /Codex/ });
    expect(codex.getAttribute("aria-pressed")).toBe("false");
    expect(codex.querySelector(".lucide-check")).toBeNull();
    fireEvent.click(codex);
    expect(onSelect).toHaveBeenCalledWith("codex");
  });

  it("names only the session's own harness, as text, where the harness is fixed, even when it could not start now", () => {
    render(<RuntimePicker harnesses={harnesses} selectedId="codex" />);
    const section = screen.getByRole("group", { name: "Run with" });
    // Nothing in the section can be chosen or followed, and the others are not listed.
    expect(section.textContent).toBe(`Run withCodex${FIXED_FOR_SESSION}`);
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("link")).toBeNull();
    const codex = within(section).getByTestId("harness-row-codex");
    expect(codex.getAttribute("aria-current")).toBe("true");
  });

  it("never offers a harness the image does not install, even one the Worker names", () => {
    const named = harnessOptions(
      [
        OPENCODE,
        CODEX,
        summary("claude", "Claude Code", ["anthropic"]),
        summary("pi", "Pi", ["anthropic"]),
      ],
      new Set(["anthropic", "openai"]),
    );
    render(<RuntimePicker harnesses={named} selectedId="claude" onSelect={vi.fn()} />);
    const section = screen.getByRole("group", { name: "Run with" });
    expect(section.textContent).toBe("Run withOpenCodeCodex");
    expect(
      within(section)
        .getByRole("button", { name: /OpenCode/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("ModelPicker", () => {
  it("lists every model: a provider's mark, name, and check, and Connect for a provider with no key", () => {
    render(
      <ModelPicker
        choices={[ANTHROPIC_KEY]}
        selectedId="mc_anthropic"
        onSelectModel={vi.fn()}
        catalog={CATALOG}
      />,
    );
    const section = screen.getByTestId("model-picker");
    expect(within(section).getAllByTestId("model-row")).toHaveLength(2);
    // No provider headings, and no footer: each row carries its own way forward.
    expect(within(section).queryByText("Anthropic")).toBeNull();
    expect(within(section).queryByText(/Connect another provider/)).toBeNull();
    const luna = within(section).getByTestId("model-connect-gpt-6-luna");
    expect(luna.getAttribute("href")).toBe("/settings/model-providers");
    expect(luna.getAttribute("aria-label")).toBe("GPT-6 Luna: connect OpenAI");
    expect(within(luna).getByText("Connect")).toBeTruthy();
    expect(luna.querySelector("svg")).not.toBeNull();
  });

  it("with no key at all still lists every model to connect, and none on a session", () => {
    const { unmount } = render(
      <ModelPicker choices={[]} selectedId={null} onSelectModel={vi.fn()} catalog={CATALOG} />,
    );
    expect(screen.getAllByText("Connect")).toHaveLength(4);
    unmount();
    render(<ModelPicker choices={[]} selectedId={null} catalog={CATALOG} />);
    expect(screen.queryByText("Connect")).toBeNull();
    expect(screen.getByTestId("model-picker").textContent).toBe(
      `ModelNo model connected${FIXED_FOR_SESSION}`,
    );
  });

  it("lists each model once when a provider has two keys, and never a key's label", () => {
    const newer: ModelChoice = {
      ...ANTHROPIC_KEY,
      id: "mc_anthropic_new",
      label: "anthropic ...ffff",
    };
    // The Worker lists newest first; the older key is the one the composer opens on.
    const choices = [newer, ANTHROPIC_KEY];
    const rows = menuRowsOf(modelRowsOf(choices), null);
    expect(rows.map((row) => [row.connectionId, row.modelId])).toEqual([
      ["mc_anthropic", "claude-sonnet-5"],
      ["mc_anthropic", "claude-haiku-4-5"],
    ]);
    // The chosen key's rows stand for its models when it is one of them.
    expect(
      new Set(menuRowsOf(modelRowsOf(choices), "mc_anthropic_new").map((row) => row.connectionId)),
    ).toEqual(new Set(["mc_anthropic_new"]));
    render(
      <ModelPicker choices={choices} selectedId={null} onSelectModel={vi.fn()} catalog={CATALOG} />,
    );
    const section = screen.getByTestId("model-picker");
    const drawn = within(section).getAllByTestId("model-row");
    expect(drawn.map((row) => row.textContent)).toEqual(["Sonnet 5", "Haiku 4.5"]);
    expect(within(section).queryByText(/anthropic \.\.\./)).toBeNull();
  });

  it("lists nothing to connect without a catalog, or when every provider has a key", () => {
    expect(unconnectedRowsOf([ANTHROPIC_KEY], undefined)).toEqual([]);
    expect(unconnectedRowsOf([ANTHROPIC_KEY, OPENAI_KEY], CATALOG)).toEqual([]);
    expect(unconnectedRowsOf([OPENAI_KEY], CATALOG).map((row) => row.modelId)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });
});

describe("the composer with a choice of harness", () => {
  function home(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const onSelectRuntime = vi.fn();
    const onSelectModel = vi.fn();
    const onSelectModelConnection = vi.fn();
    render(
      <Composer
        sessionId="new"
        modelConnections={[ANTHROPIC_KEY, OPENAI_KEY]}
        selectedModelConnectionId="mc_anthropic"
        runtimes={[OPENCODE, CODEX]}
        selectedRuntimeId="opencode"
        onSelectRuntime={onSelectRuntime}
        onSelectModel={onSelectModel}
        onSelectModelConnection={onSelectModelConnection}
        catalog={CATALOG}
        onSubmit={onSubmit}
        {...overrides}
      />,
    );
    return { onSubmit, onSelectRuntime, onSelectModel, onSelectModelConnection };
  }

  /** Opens the agent chip and answers with its panel. */
  async function openAgent() {
    fireEvent.click(screen.getByTestId("agent-chip"));
    return within(await screen.findByTestId("agent-panel"));
  }

  it("moves to a model the new harness can run when the chosen one is not", async () => {
    const { onSelectRuntime, onSelectModel, onSelectModelConnection } = home();
    const panel = await openAgent();
    fireEvent.click(panel.getByTestId("harness-row-codex"));
    expect(onSelectRuntime).toHaveBeenCalledWith("codex");
    expect(onSelectModelConnection).toHaveBeenCalledWith("mc_openai");
    // The recommended model of the provider the harness runs.
    expect(onSelectModel).toHaveBeenCalledWith("mc_openai", "gpt-6-sol");
    // The panel stays open, so what the choice moved can be seen.
    expect(screen.getByTestId("agent-panel")).toBeTruthy();
  });

  it("keeps the model when the new harness can run it", async () => {
    const { onSelectRuntime, onSelectModel } = home({ selectedModelConnectionId: "mc_openai" });
    const panel = await openAgent();
    fireEvent.click(panel.getByTestId("harness-row-codex"));
    expect(onSelectRuntime).toHaveBeenCalledWith("codex");
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("moves to a harness that can run a model the chosen harness cannot", async () => {
    const { onSelectRuntime, onSelectModel } = home({
      selectedModelConnectionId: "mc_openai",
      selectedRuntimeId: "codex",
    });
    const panel = await openAgent();
    fireEvent.click(panel.getByRole("button", { name: /Haiku 4\.5/ }));
    expect(onSelectModel).toHaveBeenCalledWith("mc_anthropic", "claude-haiku-4-5");
    expect(onSelectRuntime).toHaveBeenCalledWith("opencode");
  });

  it("keeps the harness when it can run the model picked", async () => {
    const { onSelectRuntime, onSelectModel } = home();
    const panel = await openAgent();
    fireEvent.click(panel.getByRole("button", { name: /Haiku 4\.5/ }));
    expect(onSelectModel).toHaveBeenCalled();
    expect(onSelectRuntime).not.toHaveBeenCalled();
  });

  it("sends the harness with the message where there was a choice of one", async () => {
    const { onSubmit } = home({
      selectedModelConnectionId: "mc_openai",
      selectedRuntimeId: "codex",
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix it" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[3]).toMatchObject({ runtime: "codex" });
  });

  it("with one harness enabled shows no harness section, and names none on the message", async () => {
    const { onSubmit } = home({ runtimes: [OPENCODE] });
    const panel = await openAgent();
    expect(panel.queryByTestId("runtime-picker")).toBeNull();
    expect(panel.queryByTestId("harness-row-opencode")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix it" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[3]).not.toHaveProperty("runtime");
  });

  it("draws no harness section when the Worker sent no list", async () => {
    home({ runtimes: [] });
    const panel = await openAgent();
    expect(panel.queryByTestId("runtime-picker")).toBeNull();
    expect(panel.getByTestId("model-picker")).toBeTruthy();
  });
});
