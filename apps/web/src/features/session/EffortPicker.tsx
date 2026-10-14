/**
 * The effort choice inside the composer's agent chip: one row of buttons, a
 * button per level, since the levels are a short ordered list. The levels are
 * the selected model's own, in the provider's order from the catalog. A model
 * with no effort parameter gets a line saying so instead of a row.
 */

import type { EffortLevel } from "@oncue/protocol";
import { cn } from "@/lib/utils";
import { MENU_ROW_PROPS, MenuSection } from "./composer-menu";

export interface EffortPickerProps {
  /** The model's levels, in the provider's order; `null` for a model with no effort parameter. */
  readonly levels: readonly EffortLevel[] | null;
  /** The level in force; `null` with no levels. */
  readonly value: EffortLevel | null;
  /** The model the levels belong to, named where it has none. */
  readonly modelName: string;
  readonly onChange: (level: EffortLevel) => void;
}

export function EffortPicker({ levels, value, modelName, onChange }: EffortPickerProps) {
  if (levels === null || value === null) {
    return (
      <MenuSection title="Effort" testId="effort-picker">
        <p className="px-2.5 pt-0.5 pb-1.5 text-[12.5px] text-muted-foreground">
          {modelName} has no effort setting.
        </p>
      </MenuSection>
    );
  }
  return (
    <MenuSection title="Effort" value={value} testId="effort-picker">
      {/* Each button is as wide as its word plus a share of what is left, so six levels fit one row. */}
      <div
        className="mx-1.5 mt-0.5 mb-1 flex rounded-lg bg-track p-0.5"
        data-testid="effort-levels"
      >
        {levels.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={level === value}
            onClick={() => {
              if (level !== value) {
                onChange(level);
              }
            }}
            className={cn(
              "flex-auto whitespace-nowrap rounded-md px-1.5 py-1 text-[12px] text-text outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
              level === value ? "bg-thumb shadow-sm" : "hover:bg-hover-strong",
            )}
            {...MENU_ROW_PROPS}
          >
            {level}
          </button>
        ))}
      </div>
    </MenuSection>
  );
}
