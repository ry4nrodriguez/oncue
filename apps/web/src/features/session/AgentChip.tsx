/**
 * The composer's one control for the agent: which harness runs, which model it
 * drives, and at what effort. Closed, it names the model under its provider's
 * mark with the effort beside it; open, it is one panel holding the choices,
 * so the bar keeps room for the repository and the branch. The panel is kept
 * small: the harness section appears only where there is a choice of harness.
 *
 * A popover rather than a menu: a choice of harness can move the model, and
 * the effort has its own control, so the panel stays open for those. Picking
 * a model is the last step and closes it, so it never covers Send.
 */
import type { EffortLevel } from "@oncue/protocol";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type HarnessOption, selectedHarnessOf } from "@/features/harnesses/harness-state";
import type { ModelCatalog } from "@/lib/api/setup";
import { moveRowFocus } from "./composer-menu";
import { EffortPicker } from "./EffortPicker";
import {
  type InactiveKey,
  type ModelChoice,
  ModelPicker,
  modelSummaryOf,
  RowMark,
  unconnectedRowsOf,
} from "./ModelPicker";
import { RuntimePicker, showsHarnessChoice } from "./RuntimePicker";

export interface AgentChipProps {
  /** Every harness with its state; empty when the Worker sent no list. */
  readonly harnesses: readonly HarnessOption[];
  readonly selectedHarnessId: string | null;
  /** Absent where the harness is fixed, as on a session, which keeps the one it started with. */
  readonly onSelectHarness?: ((id: string) => void) | undefined;
  /** The workspace's own model connections, empty until one is added. */
  readonly choices: readonly ModelChoice[];
  readonly selectedConnectionId: string | null;
  /** The model on that connection; `null` names its recommended row. */
  readonly selectedModelId: string | null;
  /** Both absent where the model is fixed, as on a session, whose runs keep their model. */
  readonly onSelectConnection?: ((id: string) => void) | undefined;
  readonly onSelectModel?: ((connectionId: string, modelId: string) => void) | undefined;
  /** Every provider's models, so a model with no key is listed with a Connect link. */
  readonly catalog?: ModelCatalog | undefined;
  /** Providers whose key stopped working; their models are listed with the way to replace it. */
  readonly inactiveKeys?: readonly InactiveKey[] | undefined;
  /** The selected model's levels; `null` for a model with no effort parameter. */
  readonly effortLevels: readonly EffortLevel[] | null;
  readonly effort: EffortLevel | null;
  readonly onEffortChange: (level: EffortLevel) => void;
  readonly disabled?: boolean;
}

/** Flip to the other side of the chip and slide along it, but never fall back to its left or right. */
const ATTACHED = { side: "flip", align: "shift", fallbackAxisSide: "none" } as const;

/** What the chip is called: the model, and the effort where the model has one. */
export function agentChipName(named: string, effort: EffortLevel | null): string {
  return effort === null ? `Model: ${named}` : `Model: ${named}, ${effort} effort`;
}

export function AgentChip({
  harnesses,
  selectedHarnessId,
  onSelectHarness,
  choices,
  selectedConnectionId,
  selectedModelId,
  onSelectConnection,
  onSelectModel,
  catalog,
  inactiveKeys,
  effortLevels,
  effort,
  onEffortChange,
  disabled = false,
}: AgentChipProps) {
  const model = modelSummaryOf(choices, selectedConnectionId, selectedModelId);
  const modelFixed = onSelectConnection === undefined && onSelectModel === undefined;
  const harness = selectedHarnessOf(harnesses, selectedHarnessId, onSelectHarness === undefined);
  // An effort is shown only with the levels it is one of.
  const level = effortLevels === null ? null : effort;
  // With no choice of harness, no key, and no catalog to say what a key
  // unlocks, the panel would be empty, so the chip does not open.
  const nothingToList =
    (harness === null || !showsHarnessChoice(harnesses)) &&
    choices.length === 0 &&
    (modelFixed || unconnectedRowsOf(choices, catalog).length === 0);

  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || nothingToList}
        aria-label={nothingToList ? model.label : agentChipName(model.named, level)}
        data-testid="agent-chip"
        // It never shrinks below its words; past a share of the bar the model's name truncates.
        className="group/chip flex max-w-[50cqi] shrink-0 items-center gap-1.5 rounded-md @max-[400px]/strip:px-1.5 px-2 py-1.5 text-[13px] text-text transition-colors hover:bg-hover disabled:opacity-60 data-[popup-open]:bg-hover"
      >
        <RowMark provider={model.selected?.provider} className="h-3.5 w-auto shrink-0" />
        <span className="min-w-0 truncate" data-testid="agent-chip-model">
          {model.label}
        </span>
        {level === null ? null : (
          // The first thing to go on a narrow bar, so the model's name stays. It
          // takes the text colour over the chip's hover fill, which is too dark for the muted one.
          <span
            className="@max-[460px]/strip:hidden shrink-0 text-muted-foreground group-hover/chip:text-text group-data-[popup-open]/chip:text-text"
            data-testid="agent-chip-effort"
          >
            {level}
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        // Below the chip, or above where there is more room, and never beside
        // it: a panel that fits neither way is capped, not moved away.
        collisionAvoidance={ATTACHED}
        aria-label={
          showsHarnessChoice(harnesses) ? "Harness, model, and effort" : "Model and effort"
        }
        data-testid="agent-panel"
        onKeyDown={moveRowFocus}
        // Capped to the room the page gives it. On a short screen the model list
        // scrolls inside it, so the harness and the effort stay in view.
        className="scroll-pill flex max-h-[var(--available-height)] w-[272px] max-w-[calc(100vw-24px)] flex-col divide-y divide-border-soft overflow-y-auto"
      >
        <RuntimePicker
          harnesses={harnesses}
          selectedId={harness?.id ?? null}
          onSelect={onSelectHarness}
        />
        <ModelPicker
          choices={choices}
          selectedId={selectedConnectionId}
          selectedModelId={selectedModelId}
          onSelect={onSelectConnection}
          onSelectModel={onSelectModel}
          onPicked={close}
          catalog={catalog}
          inactiveKeys={inactiveKeys}
        />
        {/* Effort belongs to a model, so with none chosen there is nothing to say about it. */}
        {model.selected === undefined ? null : (
          <EffortPicker
            levels={effortLevels}
            value={level}
            modelName={model.label}
            onChange={onEffortChange}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
