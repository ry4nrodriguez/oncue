/**
 * The harness choice inside the composer's agent chip. A harness is the coding
 * agent that runs in the sandbox. The section appears only where there is a
 * choice to make or to report: two or more harnesses this deployment has
 * enabled (`harness-state.ts`). One without a key offers Connect; one the
 * deployment has not enabled is left to Settings, Harnesses, so the panel
 * stays short. A session keeps its harness, so there the section is one line
 * of text naming it.
 */
import { Check } from "lucide-react";
import { HarnessMark } from "@/features/harnesses/HarnessMark";
import {
  HARNESSES_PATH,
  type HarnessOption,
  selectedHarnessOf,
} from "@/features/harnesses/harness-state";
import {
  CONNECT_PILL,
  FIXED_FOR_SESSION,
  MENU_ROW_PROPS,
  MenuLink,
  MenuRow,
  MenuSection,
  PANEL_CHOICE_ROW,
  PANEL_ROW,
} from "./composer-menu";

/** The harnesses this deployment has enabled: the ones that run, or would with a key. */
export function offeredHarnesses(harnesses: readonly HarnessOption[]): readonly HarnessOption[] {
  return harnesses.filter((harness) => harness.state !== "unavailable");
}

/** Whether the panel has a harness section at all: only where two or more are offered. */
export function showsHarnessChoice(harnesses: readonly HarnessOption[]): boolean {
  return offeredHarnesses(harnesses).length > 1;
}

/** The section's heading, which also names the group for assistive technology. */
export const RUN_WITH = "Run with";

const MARK = "h-3.5 w-auto shrink-0";

export interface RuntimePickerProps {
  readonly harnesses: readonly HarnessOption[];
  readonly selectedId: string | null;
  /** Absent where the harness is fixed, as on a session, which keeps the one it started with. */
  readonly onSelect?: ((id: string) => void) | undefined;
}

export function RuntimePicker({ harnesses, selectedId, onSelect }: RuntimePickerProps) {
  const fixed = onSelect === undefined;
  const selected = selectedHarnessOf(harnesses, selectedId, fixed);
  if (selected === null || !showsHarnessChoice(harnesses)) {
    return null;
  }
  if (fixed) {
    // The session's own harness, as text: the others could not be chosen here.
    return (
      <MenuSection title={RUN_WITH} testId="runtime-picker">
        <p className={PANEL_ROW} aria-current="true" data-testid={`harness-row-${selected.id}`}>
          <MenuRow
            label={selected.name}
            trailing={FIXED_FOR_SESSION}
            leading={<HarnessMark id={selected.id} box="size-3.5" className={MARK} />}
          />
        </p>
      </MenuSection>
    );
  }
  return (
    <MenuSection title={RUN_WITH} testId="runtime-picker">
      {offeredHarnesses(harnesses).map((harness) => {
        const leading = <HarnessMark id={harness.id} box="size-3.5" className={MARK} />;
        if (harness.state === "ready") {
          const chosen = harness.id === selected.id;
          return (
            <button
              key={harness.id}
              type="button"
              aria-pressed={chosen}
              data-testid={`harness-row-${harness.id}`}
              onClick={() => onSelect(harness.id)}
              className={PANEL_CHOICE_ROW}
              {...MENU_ROW_PROPS}
            >
              <MenuRow label={harness.name} leading={leading} />
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {chosen ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </button>
          );
        }
        // Not ready and still offered: its key is missing.
        return (
          <MenuLink
            key={harness.id}
            href={HARNESSES_PATH}
            className={PANEL_CHOICE_ROW}
            data-testid={`harness-row-${harness.id}`}
            aria-label={`${harness.name}: connect a key`}
            {...MENU_ROW_PROPS}
          >
            <MenuRow label={harness.name} leading={leading} />
            <span className={CONNECT_PILL}>Connect</span>
          </MenuLink>
        );
      })}
    </MenuSection>
  );
}
