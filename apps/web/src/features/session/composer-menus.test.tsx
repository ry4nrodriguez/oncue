import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSpecSummary } from "@/lib/api/setup";
import { ADD_CHOICES, AddMenu } from "./AddMenu";
import { FIXED_FOR_SESSION } from "./composer-menu";
import { EffortPicker } from "./EffortPicker";
import { type ModelChoice, ModelPicker, modelSummaryOf } from "./ModelPicker";

// A stand-in for the workspace's model connections.
const MODEL_CHOICES: readonly ModelChoice[] = [
  {
    id: "mc_opus",
    label: "anthropic ...0a1b",
    provider: "anthropic",
    modelId: "claude-opus-4-1-20250805",
  },
  {
    id: "mc_sonnet",
    label: "anthropic ...4f21",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
  },
  {
    id: "mc_haiku",
    label: "anthropic ...9c3d",
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Base UI activates a menu item from the pointer sequence, not a bare `click`.
 * jsdom has no layout, so a menu hidden under the page still passes here;
 * `e2e/repository-picker.spec.ts` covers that.
 */
function pointerClick(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse", isPrimary: true });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
}

describe("AddMenu", () => {
  it("offers every choice with the line saying what it does", async () => {
    render(<AddMenu />);
    pointerClick(screen.getByRole("button", { name: "Add" }));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(ADD_CHOICES.length);
    for (const choice of ADD_CHOICES) {
      expect(within(menu).getByText(choice.label)).not.toBeNull();
      expect(within(menu).getByText(choice.description)).not.toBeNull();
    }
  });

  it("reports the choice the user makes", async () => {
    const onChoose = vi.fn();
    render(<AddMenu onChoose={onChoose} />);
    pointerClick(screen.getByRole("button", { name: "Add" }));

    const menu = await screen.findByRole("menu");
    pointerClick(within(menu).getByRole("menuitem", { name: /Add photos and files/ }));

    await waitFor(() => {
      expect(onChoose).toHaveBeenCalledWith("files");
    });
  });

  it("cannot be opened while disabled", () => {
    render(<AddMenu disabled />);
    pointerClick(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("ModelPicker", () => {
  const rows = () => within(screen.getByTestId("model-picker")).getAllByTestId("model-row");

  it("names its section and reports the connection the user picks", () => {
    const onSelect = vi.fn();
    render(<ModelPicker choices={MODEL_CHOICES} selectedId="mc_opus" onSelect={onSelect} />);
    expect(screen.getByRole("group", { name: "Model" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Haiku 4\.5/ }));
    expect(onSelect).toHaveBeenCalledWith("mc_haiku");
  });

  it("marks exactly the selected connection as pressed, with the check", () => {
    render(<ModelPicker choices={MODEL_CHOICES} selectedId="mc_sonnet" onSelect={vi.fn()} />);
    const pressed = rows().filter((row) => row.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toContain("Sonnet 4.5");
    expect(pressed[0]?.querySelector(".lucide-check")).not.toBeNull();
    expect(rows().filter((row) => row.querySelector(".lucide-check") !== null)).toHaveLength(1);
  });

  it("offers every connection as its model, by name alone, with no key's label", () => {
    render(<ModelPicker choices={MODEL_CHOICES} selectedId="mc_opus" onSelect={vi.fn()} />);
    expect(rows()).toHaveLength(MODEL_CHOICES.length);
    const expected = [
      ["Opus 4.1", "anthropic ...0a1b"],
      ["Sonnet 4.5", "anthropic ...4f21"],
      ["Haiku 4.5", "anthropic ...9c3d"],
    ] as const;
    for (const [index, [name, label]] of expected.entries()) {
      const text = rows()[index]?.textContent ?? "";
      // The model's name and nothing else: its mark, then the name.
      expect(text).toBe(name);
      expect(text).not.toContain(label);
      expect(rows()[index]?.querySelector("svg")).toBeTruthy();
    }
  });

  it("falls back to the label alone, with no mark, for a choice that names no model", () => {
    render(
      <ModelPicker
        choices={[{ id: "mc_plain", label: "Other key" }]}
        selectedId="mc_plain"
        onSelect={vi.fn()}
      />,
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toBe("Other key");
    expect(rows()[0]?.querySelector("svg[fill='currentColor']")).toBeNull();
  });

  it("presses no row for a selected connection that is not among the active ones", () => {
    render(<ModelPicker choices={MODEL_CHOICES} selectedId="gone" onSelect={vi.fn()} />);
    expect(rows().every((row) => row.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("names the model as text, with no choice, where nothing can change the selection", () => {
    render(<ModelPicker choices={MODEL_CHOICES} selectedId="mc_sonnet" />);
    const section = screen.getByTestId("model-picker");
    expect(within(section).queryByRole("button")).toBeNull();
    expect(section.textContent).toBe(`ModelSonnet 4.5${FIXED_FOR_SESSION}`);
    cleanup();

    // A session whose connection is gone says so in the same place.
    render(<ModelPicker choices={MODEL_CHOICES} selectedId="gone" />);
    expect(screen.getByTestId("model-picker").textContent).toBe(
      `ModelModel unavailable${FIXED_FOR_SESSION}`,
    );
  });

  it("says no model is connected where there is no connection and nothing to connect", () => {
    render(<ModelPicker choices={[]} selectedId={null} onSelect={vi.fn()} />);
    const section = screen.getByTestId("model-picker");
    expect(section.textContent).toBe("ModelNo model connected");
    expect(within(section).queryByRole("button")).toBeNull();
  });

  it("summarises the selection for the chip: its words, and the name read out", () => {
    expect(modelSummaryOf(MODEL_CHOICES, "mc_sonnet", null)).toMatchObject({
      label: "Sonnet 4.5",
      named: "Sonnet 4.5",
    });
    expect(modelSummaryOf(MODEL_CHOICES, "gone", null)).toEqual({
      selected: undefined,
      label: "Model unavailable",
      named: "unavailable",
    });
    expect(modelSummaryOf(MODEL_CHOICES, null, null)).toEqual({
      selected: undefined,
      label: "Add a model",
      named: "none",
    });
    expect(modelSummaryOf([], null, null)).toEqual({
      selected: undefined,
      label: "No model connected",
      named: "none",
    });
    expect(modelSummaryOf([], "gone", null).named).toBe("unavailable");
  });
});

describe("EffortPicker", () => {
  /** Anthropic's five levels, the provider's own words, as the catalog lists them. */
  const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
  const levelNames = () =>
    within(screen.getByTestId("effort-levels"))
      .getAllByRole("button")
      .map((button) => button.textContent);

  it("names the current level beside its heading, in the provider's word", () => {
    render(<EffortPicker levels={LEVELS} value="max" modelName="Opus 5.5" onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Effort: max" }).textContent).toContain("Effortmax");
  });

  it.each([
    [["low", "medium", "high", "xhigh", "max"]],
    [["none", "low", "medium", "high", "xhigh", "max"]],
    [["low", "medium", "high", "xhigh"]],
    [["none", "low"]],
  ] as const)(
    "offers exactly the model's levels, one button each, in the catalog's order: %j",
    (levels) => {
      render(<EffortPicker levels={levels} value="low" modelName="A model" onChange={vi.fn()} />);
      expect(levelNames()).toEqual([...levels]);
      // One row that never wraps a word: each button keeps its word on one line.
      for (const button of within(screen.getByTestId("effort-levels")).getAllByRole("button")) {
        expect(button.className).toContain("whitespace-nowrap");
        expect(button.className).toContain("flex-auto");
      }
    },
  );

  it("reports the level the user picks, as a level, and not the one already set", () => {
    const onChange = vi.fn();
    render(<EffortPicker levels={LEVELS} value="high" modelName="Opus 5.5" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "high" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "low" }));
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("marks only the current level as pressed, and raises it", () => {
    render(<EffortPicker levels={LEVELS} value="medium" modelName="Opus 5.5" onChange={vi.fn()} />);
    const pressed = within(screen.getByTestId("effort-levels"))
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed.map((button) => button.textContent)).toEqual(["medium"]);
    expect(pressed[0]?.className).toContain("bg-thumb");
    expect(screen.getByRole("button", { name: "max" }).className).not.toContain("bg-thumb");
  });

  it("presses nothing for a level the model does not list", () => {
    render(
      <EffortPicker levels={["low", "high"]} value="max" modelName="A model" onChange={vi.fn()} />,
    );
    expect(
      screen
        .getAllByRole("button")
        .every((button) => button.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
  });

  it("says a model has no effort setting, in place of the row", () => {
    render(<EffortPicker levels={null} value={null} modelName="Haiku 4.5" onChange={vi.fn()} />);
    const section = screen.getByRole("group", { name: "Effort" });
    expect(section.textContent).toBe("EffortHaiku 4.5 has no effort setting.");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();

    // Levels with no level in force say the same, rather than a row with nothing pressed.
    render(<EffortPicker levels={LEVELS} value={null} modelName="Opus 5.5" onChange={vi.fn()} />);
    expect(screen.getByTestId("effort-picker").textContent).toBe(
      "EffortOpus 5.5 has no effort setting.",
    );
  });
});

describe("ModelPicker with the catalog", () => {
  const spec = (modelId: string, name: string, recommended = false): ModelSpecSummary => ({
    modelId,
    name,
    contextWindow: modelId.startsWith("claude-haiku") ? 200_000 : 1_000_000,
    effort: modelId.startsWith("claude-haiku") ? null : ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: modelId.startsWith("claude-haiku") ? null : "high",
    price: { inputPerMTok: 2, outputPerMTok: 10 },
    status: modelId.endsWith("20250929") ? "legacy" : "current",
    recommended,
  });
  const WITH_CATALOG = [
    {
      id: "mc_1",
      label: "anthropic ...4f21",
      provider: "anthropic" as const,
      modelId: "claude-opus-5-5",
      models: [
        spec("claude-fable-5-1", "Claude Fable 5.1"),
        spec("claude-opus-5-5", "Claude Opus 5.5", true),
        spec("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
        spec("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
      ],
    },
  ];

  it("names the recommended model when none is named, and lists every row by name alone", () => {
    const onSelectModel = vi.fn();
    render(
      <ModelPicker
        choices={WITH_CATALOG}
        selectedId="mc_1"
        onSelect={vi.fn()}
        onSelectModel={onSelectModel}
      />,
    );
    const rows = screen.getAllByTestId("model-row");
    // The brand word is the mark's job: the chip and the rows say "Opus 5.5".
    expect(modelSummaryOf(WITH_CATALOG, "mc_1", null).label).toBe("Opus 5.5");
    // With no model named, the connection's recommended row is the pressed one.
    expect(rows.map((row) => row.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    // Names, and "Legacy" where the provider retired the model; no prices.
    expect(rows.map((row) => row.textContent)).toEqual([
      "Fable 5.1",
      "Opus 5.5",
      "Haiku 4.5",
      "Sonnet 4.5Legacy",
    ]);
    // No provider heading, and without a catalog nothing of the other provider to list.
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(screen.queryByRole("link", { name: /connect/ })).toBeNull();
    fireEvent.click(rows[0] as Element);
    expect(onSelectModel).toHaveBeenCalledWith("mc_1", "claude-fable-5-1");
  });

  it("lists both providers' rows in one run, each under its own mark, with no headings", () => {
    render(
      <ModelPicker
        choices={[
          ...WITH_CATALOG,
          {
            id: "mc_2",
            label: "openai ...9c03",
            provider: "openai" as const,
            modelId: "gpt-6-sol",
            models: [spec("gpt-6-sol", "GPT-6 Sol", true)],
          },
        ]}
        selectedId="mc_2"
        onSelect={vi.fn()}
        onSelectModel={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId("model-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Fable 5.1",
      "Opus 5.5",
      "Haiku 4.5",
      "Sonnet 4.5Legacy",
      "GPT-6 Sol",
    ]);
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(screen.queryByText("OpenAI")).toBeNull();
    expect(rows.every((row) => row.querySelector("svg") !== null)).toBe(true);
    expect(screen.queryByRole("link", { name: /connect/ })).toBeNull();
  });

  it("names the model a selection names", () => {
    render(
      <ModelPicker
        choices={WITH_CATALOG}
        selectedId="mc_1"
        selectedModelId="claude-haiku-4-5-20251001"
      />,
    );
    expect(screen.getByTestId("model-picker").textContent).toBe(
      `ModelHaiku 4.5${FIXED_FOR_SESSION}`,
    );
  });
});
