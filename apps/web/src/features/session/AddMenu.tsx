/**
 * The composer's add control: attach files (see `docs/decisions.md`) and the
 * "Skip required checks" toggle, sent as a flag on the run command so the
 * object never reads the message text to learn it.
 */
import { Paperclip, Plus, ShieldOff } from "lucide-react";
import { type ComponentType, type RefObject, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_ROW, MenuRow } from "./composer-menu";

export interface AddChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: ComponentType<{ className?: string }>;
}

export const ADD_CHOICES: readonly AddChoice[] = [
  {
    id: "files",
    label: "Add photos and files",
    description: "Upload from your computer",
    icon: Paperclip,
  },
];

export interface AddMenuProps {
  readonly disabled?: boolean;
  readonly onChoose?: (id: string) => void;
  /** What the panel lines up with: the whole composer, not the button. */
  readonly anchorRef?: RefObject<HTMLElement | null>;
  /** A row at the foot of the anchor that the open panel covers. */
  readonly coverRef?: RefObject<HTMLElement | null>;
  /**
   * The next run skips its required checks and cannot end verified. Shown only
   * when the caller passes a handler.
   */
  readonly skipRequiredChecks?: boolean;
  readonly onSkipRequiredChecksChange?: (skip: boolean) => void;
}

export function AddMenu({
  disabled = false,
  onChoose,
  anchorRef,
  coverRef,
  skipRequiredChecks,
  onSkipRequiredChecksChange,
}: AddMenuProps) {
  // Measured when the menu opens, not during render.
  const [cover, setCover] = useState(0);

  return (
    <DropdownMenu
      onOpenChange={(next) => {
        if (next) {
          setCover(coverRef?.current?.offsetHeight ?? 0);
        }
      }}
    >
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Add"
        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-text disabled:opacity-60"
      >
        <Plus className="size-[18px]" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        // Negative, so the panel covers the strip.
        sideOffset={-cover}
        {...(anchorRef === undefined ? {} : { anchor: anchorRef })}
        className="w-[var(--anchor-width)] min-w-[320px] border-border bg-popover p-1.5 shadow-xl"
      >
        {ADD_CHOICES.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            className={MENU_ROW}
            onClick={() => onChoose?.(choice.id)}
          >
            <MenuRow
              label={choice.label}
              description={choice.description}
              leading={
                <choice.icon className="size-[15px] shrink-0 text-muted-foreground" aria-hidden />
              }
            />
          </DropdownMenuItem>
        ))}
        {onSkipRequiredChecksChange === undefined ? null : (
          <DropdownMenuCheckboxItem
            checked={skipRequiredChecks ?? false}
            onCheckedChange={(checked) => onSkipRequiredChecksChange(checked)}
            // Base UI keeps a menu open after a checkbox by default; closing
            // reveals the chip the toggle just added.
            closeOnClick
            className={MENU_ROW}
          >
            <MenuRow
              label="Skip required checks"
              description="For the next message only"
              leading={
                <ShieldOff className="size-[15px] shrink-0 text-muted-foreground" aria-hidden />
              }
              trailing={skipRequiredChecks === true ? "On" : undefined}
            />
          </DropdownMenuCheckboxItem>
        )}
        {/* A paragraph, not a row: it describes the menu and is not choosable. */}
        <p className="mt-1 border-border-soft border-t pt-2 pb-1 text-center text-[12.5px] text-faint">
          Plugins and skills coming soon
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
