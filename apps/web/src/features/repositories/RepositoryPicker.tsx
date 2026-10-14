/**
 * The composer's repository control. The server never picks a repository for
 * the user, so the user sees and can change it here; the Worker still refuses
 * any repository that is not the caller's and verified, so this is not a
 * security boundary.
 *
 * It is a menu, not the Base UI Combobox: driven from a separate trigger, the
 * Combobox leaves its input in the accessibility tree without making it
 * visible or focusable.
 */
import { Check, ChevronsUpDown } from "lucide-react";
import { GitHubMark } from "@/components/brand/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RepositorySummary } from "@/lib/api/setup";
import { cn } from "@/lib/utils";

export interface RepositoryPickerProps {
  readonly repositories: readonly RepositorySummary[];
  readonly selectedId: string | null;
  readonly onSelect: (repositoryConnectionId: string) => void;
  readonly disabled?: boolean;
  /** Renders a static label: a session's repository cannot change once it exists (record 07). */
  readonly fixedLabel?: string | null;
}

/** What the control says when there is nothing to choose or nothing chosen. */
const NO_REPOSITORY = "No repository";

/**
 * In the composer's bar the repository gives way first: it shrinks before the
 * branch does, down to a floor that still shows the start of its name.
 */
const CONTROL =
  "flex min-w-[min(5rem,27cqi)] shrink-[999] items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors disabled:opacity-60 @max-[400px]/strip:gap-1.5 @max-[400px]/strip:px-1.5";

/** The owner and the repository's own name, split so a narrow bar can drop the owner. */
export function splitRepositoryName(fullName: string): readonly [owner: string, name: string] {
  const slash = fullName.lastIndexOf("/");
  return [fullName.slice(0, slash + 1), fullName.slice(slash + 1)];
}

/** The name, truncating; on a narrow bar the part after the slash alone. */
function RepositoryName({ fullName, className }: { fullName: string; className: string }) {
  const [owner, name] = splitRepositoryName(fullName);
  return (
    <span className={cn("min-w-0 truncate", className)}>
      <span className="@max-[560px]/strip:hidden">{owner}</span>
      {name}
    </span>
  );
}

export function RepositoryPicker({
  repositories,
  selectedId,
  onSelect,
  disabled = false,
  fixedLabel = null,
}: RepositoryPickerProps) {
  if (fixedLabel !== null) {
    return (
      // The title keeps the whole name within reach where the bar shows part of it.
      <span className={cn(CONTROL, "text-text")} title={fixedLabel}>
        <GitHubMark className="size-[15px] shrink-0 text-muted-foreground" />
        <RepositoryName fullName={fixedLabel} className="max-w-[260px]" />
      </span>
    );
  }

  // With nothing connected the control is inert rather than hidden, so it can
  // say why it is empty. The setup gate means only the dev harness reaches this.
  if (repositories.length === 0) {
    return (
      <span className={cn(CONTROL, "text-faint")}>
        <GitHubMark className="size-[15px] shrink-0" />
        <span className="min-w-0 truncate">{NO_REPOSITORY}</span>
      </span>
    );
  }

  const selected = repositories.find(
    (repository) => repository.repositoryConnectionId === selectedId,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(CONTROL, "text-text hover:bg-hover")}
        aria-label={
          selected === undefined
            ? "Choose a repository"
            : `Repository: ${selected.fullName}. Choose a different one`
        }
      >
        <GitHubMark className="size-[15px] shrink-0 text-muted-foreground" />
        <RepositoryName fullName={selected?.fullName ?? NO_REPOSITORY} className="max-w-[220px]" />
        <ChevronsUpDown
          className="@max-[400px]/strip:hidden size-3.5 shrink-0 text-faint"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      {/* Opens downward; the capped height keeps it on screen, and Base UI flips it when even that does not fit. */}
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-[264px] border-border bg-popover p-1 shadow-xl"
      >
        {/* Scrolls on an inner element: the popup keeps `overflow-hidden` so its corners clip the rows. */}
        <div className="scroll-pill max-h-[228px] overflow-y-auto overscroll-contain">
          {/* A radio group: one choice, one handler, and single-choice semantics for screen readers. */}
          <DropdownMenuRadioGroup
            value={selectedId ?? ""}
            onValueChange={(value) => {
              if (typeof value === "string" && value.length > 0) {
                onSelect(value);
              }
            }}
          >
            {repositories.map((repository) => (
              <DropdownMenuRadioItem
                key={repository.repositoryConnectionId}
                value={repository.repositoryConnectionId}
                className="gap-2 px-2 py-1 text-[12.5px] text-text data-[highlighted]:bg-hover"
              >
                <GitHubMark className="size-[13px] shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{repository.fullName}</span>
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <DropdownMenuRadioItemIndicator>
                    <Check className="size-3.5" aria-hidden="true" />
                  </DropdownMenuRadioItemIndicator>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
