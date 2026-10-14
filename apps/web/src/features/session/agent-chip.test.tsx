import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLAY_CLASS } from "@/components/brand/icons";
import { harnessOptions } from "@/features/harnesses/harness-state";
import type { ModelCatalog, ModelSpecSummary, RuntimeSummary } from "@/lib/api/setup";
import { AgentChip, type AgentChipProps, agentChipName } from "./AgentChip";
import { FIXED_FOR_SESSION } from "./composer-menu";
import type { ModelChoice } from "./ModelPicker";

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
    effort: ["low", "medium", "high"],
    defaultEffort: "medium",
    price: { inputPerMTok: 3, outputPerMTok: 15 },
    status: "current",
    recommended,
  };
}
const CATALOG: ModelCatalog = {
  anthropic: [
    spec("claude-sonnet-4-5", "Claude Sonnet 4.5", true),
    spec("claude-haiku-4-5", "Claude Haiku 4.5"),
  ],
  openai: [spec("gpt-6-sol", "GPT-6 Sol", true)],
};
const ANTHROPIC_KEY: ModelChoice = {
  id: "mc_anthropic",
  label: "anthropic ...0a1b",
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  models: CATALOG.anthropic,
};
const OPENAI_KEY: ModelChoice = {
  id: "mc_openai",
  label: "openai ...9c3d",
  provider: "openai",
  modelId: "gpt-6-sol",
  models: CATALOG.openai,
};
const HARNESSES = harnessOptions([OPENCODE, CODEX], new Set(["anthropic", "openai"]));
const LEVELS = ["low", "medium", "high"] as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A chip as Home draws it: everything can be chosen. */
function chip(overrides: Partial<AgentChipProps> = {}) {
  const handlers = {
    onSelectHarness: vi.fn(),
    onSelectConnection: vi.fn(),
    onSelectModel: vi.fn(),
    onEffortChange: vi.fn(),
  };
  render(
    <AgentChip
      harnesses={HARNESSES}
      selectedHarnessId="opencode"
      choices={[ANTHROPIC_KEY, OPENAI_KEY]}
      selectedConnectionId="mc_anthropic"
      selectedModelId={null}
      catalog={CATALOG}
      effortLevels={LEVELS}
      effort="medium"
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

/** A chip as a session draws it: the harness and the model are the session's own. */
function sessionChip(overrides: Partial<AgentChipProps> = {}) {
  const onEffortChange = vi.fn();
  render(
    <AgentChip
      harnesses={HARNESSES}
      selectedHarnessId="codex"
      choices={[ANTHROPIC_KEY, OPENAI_KEY]}
      selectedConnectionId="mc_openai"
      selectedModelId="gpt-6-sol"
      effortLevels={LEVELS}
      effort="high"
      onEffortChange={onEffortChange}
      {...overrides}
    />,
  );
  return { onEffortChange };
}

async function open() {
  fireEvent.click(screen.getByTestId("agent-chip"));
  return await screen.findByTestId("agent-panel");
}

describe("AgentChip", () => {
  it("shows the model under its provider's mark, the effort beside it, and a chevron", () => {
    chip();
    const trigger = screen.getByTestId("agent-chip");
    expect(trigger.textContent).toBe("Sonnet 4.5medium");
    expect(screen.getByTestId("agent-chip-model").textContent).toBe("Sonnet 4.5");
    expect(screen.getByTestId("agent-chip-effort").textContent).toBe("medium");
    // The provider's mark first, in Claude's own colour, and the chevron last.
    const marks = trigger.querySelectorAll("svg");
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute("class")).toContain(CLAUDE_CLAY_CLASS);
    expect(marks[1]?.getAttribute("class")).toContain("lucide-chevron-down");
    expect(trigger.getAttribute("aria-label")).toBe("Model: Sonnet 4.5, medium effort");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("names the model alone where it has no effort, and draws no mark for an unknown provider", () => {
    expect(agentChipName("Haiku 4.5", null)).toBe("Model: Haiku 4.5");
    expect(agentChipName("Opus 5.5", "max")).toBe("Model: Opus 5.5, max effort");
    chip({
      choices: [{ id: "mc_plain", label: "Other key" }],
      selectedConnectionId: "mc_plain",
      effortLevels: null,
      effort: null,
    });
    const trigger = screen.getByTestId("agent-chip");
    expect(trigger.textContent).toBe("Other key");
    expect(trigger.getAttribute("aria-label")).toBe("Model: Other key");
    // Only the chevron.
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  });

  it("opens one panel holding the harness, the model, and the effort, top to bottom", async () => {
    chip();
    const panel = await open();
    expect(screen.getByRole("dialog", { name: "Harness, model, and effort" })).toBe(panel);
    expect(
      within(panel)
        .getAllByRole("group")
        .map((group) => group.dataset.testid),
    ).toEqual(["runtime-picker", "model-picker", "effort-picker"]);
    expect(screen.getByTestId("agent-chip").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps Claude's colour on every Claude mark in the panel, and gives OpenAI's none", async () => {
    chip({ selectedConnectionId: "mc_openai" });
    // The chip follows the selected model's provider.
    const chipMark = screen.getByTestId("agent-chip").querySelector("svg");
    expect(chipMark?.getAttribute("class")).not.toContain(CLAUDE_CLAY_CLASS);
    const panel = within(await open());
    const markOf = (row: HTMLElement) => row.querySelector("svg")?.getAttribute("class") ?? "";
    for (const row of panel.getAllByTestId("model-row")) {
      const claude = row.dataset.model?.startsWith("claude-") === true;
      expect(markOf(row).includes(CLAUDE_CLAY_CLASS)).toBe(claude);
    }
    expect(markOf(panel.getByTestId("harness-row-codex"))).not.toContain(CLAUDE_CLAY_CLASS);
  });

  it("reports each choice through its own callback, stays open for a harness or an effort, and closes on a model", async () => {
    const handlers = chip();
    const panel = within(await open());
    fireEvent.click(panel.getByTestId("harness-row-codex"));
    expect(handlers.onSelectHarness).toHaveBeenCalledWith("codex");
    fireEvent.click(panel.getByRole("button", { name: "high" }));
    expect(handlers.onEffortChange).toHaveBeenCalledWith("high");
    expect(screen.getByTestId("agent-panel")).toBeTruthy();
    // The model is the last step, so picking one closes the panel and uncovers Send.
    fireEvent.click(panel.getByRole("button", { name: /GPT-6 Sol/ }));
    expect(handlers.onSelectConnection).toHaveBeenCalledWith("mc_openai");
    expect(handlers.onSelectModel).toHaveBeenCalledWith("mc_openai", "gpt-6-sol");
    await waitFor(() => expect(screen.queryByTestId("agent-panel")).toBeNull());
  });

  it("on a session names the harness and the model as fixed, and still changes the effort", async () => {
    const { onEffortChange } = sessionChip();
    expect(screen.getByTestId("agent-chip").getAttribute("aria-label")).toBe(
      "Model: GPT-6 Sol, high effort",
    );
    const panel = within(await open());
    // Only the session's own harness is named, and it cannot be changed.
    expect(panel.getByTestId("runtime-picker").textContent).toBe(
      `Run withCodex${FIXED_FOR_SESSION}`,
    );
    expect(panel.getByTestId("harness-row-codex").getAttribute("aria-current")).toBe("true");
    expect(panel.getByTestId("model-picker").textContent).toBe(
      `ModelGPT-6 Sol${FIXED_FOR_SESSION}`,
    );
    // Nothing to choose but the effort's levels.
    expect(panel.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    fireEvent.click(panel.getByRole("button", { name: "low" }));
    expect(onEffortChange).toHaveBeenCalledWith("low");
  });

  it("names the model alone and says it has no effort setting, for a model with no levels or no level set", async () => {
    sessionChip({ effortLevels: null, effort: "high" });
    expect(screen.queryByTestId("agent-chip-effort")).toBeNull();
    expect(screen.getByTestId("agent-chip").textContent).toBe("GPT-6 Sol");
    expect(within(await open()).getByTestId("effort-picker").textContent).toBe(
      "EffortGPT-6 Sol has no effort setting.",
    );
    cleanup();

    sessionChip({ effortLevels: LEVELS, effort: null });
    expect(screen.getByTestId("agent-chip").getAttribute("aria-label")).toBe("Model: GPT-6 Sol");
    expect(within(await open()).getByTestId("effort-picker").textContent).toBe(
      "EffortGPT-6 Sol has no effort setting.",
    );
  });

  it("says nothing about effort where no model is chosen", async () => {
    chip({ selectedConnectionId: null, effortLevels: null, effort: null });
    const panel = within(await open());
    expect(panel.getByTestId("model-picker")).toBeTruthy();
    expect(panel.queryByTestId("effort-picker")).toBeNull();
  });

  it("says a session's model is unavailable, or that none is chosen, rather than naming another", () => {
    sessionChip({ selectedConnectionId: "gone", effortLevels: null, effort: null });
    expect(screen.getByTestId("agent-chip").textContent).toBe("Model unavailable");
    expect(screen.getByTestId("agent-chip").getAttribute("aria-label")).toBe("Model: unavailable");
    cleanup();

    chip({ selectedConnectionId: null, effortLevels: null, effort: null });
    expect(screen.getByTestId("agent-chip").textContent).toBe("Add a model");
    expect(screen.getByTestId("agent-chip").getAttribute("aria-label")).toBe("Model: none");
  });

  it("with no key still opens on what a key unlocks, or on the harnesses to connect", async () => {
    chip({ choices: [], selectedConnectionId: null, harnesses: [], effortLevels: null });
    const trigger = screen.getByTestId<HTMLButtonElement>("agent-chip");
    expect(trigger.textContent).toBe("No model connected");
    expect(trigger.disabled).toBe(false);
    expect(within(await open()).getAllByText("Connect")).toHaveLength(3);
    cleanup();

    // No catalog, but a choice of harnesses: each one's Connect is still worth opening for.
    chip({
      choices: [],
      selectedConnectionId: null,
      harnesses: harnessOptions([OPENCODE, CODEX], new Set()),
      catalog: undefined,
      effortLevels: null,
    });
    const panel = within(await open());
    expect(panel.getByRole("link", { name: "OpenCode: connect a key" })).toBeTruthy();
    expect(panel.getByTestId("model-picker").textContent).toBe("ModelNo model connected");
  });

  it("lists a rejected key's models greyed, with the reason in words and a Replace to Model providers", async () => {
    const handlers = chip({
      choices: [ANTHROPIC_KEY],
      inactiveKeys: [{ provider: "openai", status: "invalid" }],
    });
    const panel = within(await open());

    const row = panel.getByRole("link", {
      name: "GPT-6 Sol: key rejected, replace the OpenAI key",
    });
    expect(row.getAttribute("href")).toBe("/settings/model-providers");
    expect(row.getAttribute("data-testid")).toBe("model-replace-gpt-6-sol");
    expect(row.textContent).toBe("GPT-6 SolKey rejectedReplace");
    // It is a way to fix the key, never a choice: nothing is selected by following it.
    expect(row.getAttribute("aria-pressed")).toBeNull();
    fireEvent.click(row);
    expect(handlers.onSelectModel).not.toHaveBeenCalled();
    expect(handlers.onSelectConnection).not.toHaveBeenCalled();
    // The provider with a working key is still offered as before, and nothing reads "Connect".
    expect(panel.getAllByTestId("model-row")).toHaveLength(2);
    expect(panel.queryByText("Connect")).toBeNull();
  });

  it.each([
    ["expired", "Key expired"],
    ["attention_required", "Key needs attention"],
  ] as const)("says why a key whose status is %s stopped working", async (status, words) => {
    chip({ choices: [ANTHROPIC_KEY], inactiveKeys: [{ provider: "openai", status }] });
    const row = within(await open()).getByTestId("model-replace-gpt-6-sol");
    expect(row.textContent).toBe(`GPT-6 Sol${words}Replace`);
  });

  it("keeps Connect for a provider with no key, beside a provider whose key was rejected", async () => {
    chip({
      choices: [],
      selectedConnectionId: null,
      effortLevels: null,
      inactiveKeys: [{ provider: "openai", status: "invalid" }],
    });
    const panel = within(await open());
    expect(panel.getByTestId("model-connect-claude-sonnet-4-5").textContent).toContain("Connect");
    expect(panel.getByTestId("model-replace-gpt-6-sol").textContent).toContain("Replace");
  });

  it("offers a provider's models as usual when it holds a working key beside one that stopped", async () => {
    chip({ inactiveKeys: [{ provider: "openai", status: "invalid" }] });
    const panel = within(await open());
    expect(panel.queryByTestId("model-replace-gpt-6-sol")).toBeNull();
    expect(panel.getAllByTestId("model-row")).toHaveLength(3);
  });

  it("does not open with nothing to list: no harnesses, no key, and no catalog or no way to choose", () => {
    chip({
      choices: [],
      selectedConnectionId: null,
      harnesses: [],
      catalog: undefined,
      effortLevels: null,
    });
    const trigger = screen.getByTestId<HTMLButtonElement>("agent-chip");
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-label")).toBe("No model connected");
    cleanup();

    // One harness is no choice, so with no key and no catalog there is still nothing to list.
    chip({
      choices: [],
      selectedConnectionId: null,
      harnesses: harnessOptions([OPENCODE], new Set()),
      catalog: undefined,
      effortLevels: null,
    });
    expect(screen.getByTestId<HTMLButtonElement>("agent-chip").disabled).toBe(true);
    cleanup();

    // A session cannot connect from here, so the catalog gives it nothing to list.
    sessionChip({ choices: [], harnesses: [], catalog: CATALOG, effortLevels: null });
    expect(screen.getByTestId<HTMLButtonElement>("agent-chip").disabled).toBe(true);
  });

  it("cannot be opened while disabled", () => {
    chip({ disabled: true });
    const trigger = screen.getByTestId<HTMLButtonElement>("agent-chip");
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByTestId("agent-panel")).toBeNull();
  });

  it("moves between the rows on the arrow keys, and leaves every other key alone", async () => {
    chip();
    const panel = await open();
    const rows = [
      within(panel).getByTestId("harness-row-opencode"),
      within(panel).getByTestId("harness-row-codex"),
    ];
    const press = (key: string) => fireEvent.keyDown(document.activeElement ?? panel, { key });

    rows[0]?.focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    press("ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
    // Nothing above the first row.
    press("ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
    press("Home");
    expect(document.activeElement).toBe(rows[0]);

    // The effort's levels are the last stops: down from the last row, and no further.
    const lastModel = within(panel).getAllByTestId("model-row").at(-1) as HTMLElement;
    const low = within(panel).getByRole("button", { name: "low" });
    const high = within(panel).getByRole("button", { name: "high" });
    lastModel.focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(low);
    high.focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(high);

    // With focus on the panel itself, not a row, the arrows are left alone.
    panel.focus();
    fireEvent.keyDown(panel, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(rows[0]);
  });
});
