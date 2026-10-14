/**
 * The approvals picker on the line below the composer, which names the mode
 * in force: how the agent's own permission asks are answered
 * (record 09, "Agent permissions"). A Base UI menu, so it opens, closes, and
 * moves between rows from the keyboard like the composer's other menus. The
 * choice is sent to the control plane, which decides every ask; the menu only
 * says what is in force.
 */

import type { ApprovalMode } from "@oncue/protocol";
import { Check, ChevronsUpDown } from "lucide-react";
import { useId } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MODE_CHOICES, modeChoice } from "./approval-modes";

export const APPROVAL_MENU_HEADING = "How should agent actions be approved?";

export interface ApprovalModeMenuProps {
  /** Null when the workspace's setting cannot be read: the picker claims no mode. */
  readonly mode: ApprovalMode | null;
  /** Absent: the picker shows the mode and its menu cannot change it. */
  readonly onChange?: ((mode: ApprovalMode) => void) | undefined;
  readonly disabled?: boolean;
}

export function ApprovalModeMenu({ mode, onChange, disabled = false }: ApprovalModeMenuProps) {
  const headingId = useId();
  const current = mode === null ? null : modeChoice(mode);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={
          current === null
            ? "Approvals: not known. Change how agent actions are approved"
            : `Approvals: ${current.name}. Change how agent actions are approved`
        }
        title={current === null ? "Approvals" : `Approvals: ${current.name}`}
        data-testid="approval-mode"
        data-mode={mode ?? "unknown"}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-hover-strong hover:text-text disabled:opacity-60"
      >
        <span data-testid="approval-mode-chip" className="text-text">
          {current === null ? "Approvals" : current.chip}
        </span>
        <ChevronsUpDown className="size-3.5 text-faint" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[400px] max-w-[calc(100vw-32px)] border-border bg-popover p-1.5 shadow-xl outline-none"
      >
        <p id={headingId} className="px-2.5 pt-1 pb-1.5 text-[12.5px] text-muted-foreground">
          {APPROVAL_MENU_HEADING}
        </p>
        <DropdownMenuRadioGroup
          aria-labelledby={headingId}
          value={mode ?? ""}
          onValueChange={(value) => {
            if (value !== mode) {
              onChange?.(value as ApprovalMode);
            }
          }}
        >
          {MODE_CHOICES.map((choice) => (
            <DropdownMenuRadioItem
              key={choice.mode}
              value={choice.mode}
              disabled={onChange === undefined}
              data-testid={`approval-mode-${choice.mode}`}
              className="items-start gap-2.5 px-2.5 py-2 data-[highlighted]:bg-hover"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[13px] text-text">{choice.name}</span>
                <span className="text-[12px] text-muted-foreground">{choice.description}</span>
              </span>
              <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                <DropdownMenuRadioItemIndicator>
                  <Check className="size-3.5 text-text" aria-hidden="true" />
                </DropdownMenuRadioItemIndicator>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
