/**
 * The composer's branch control, beside the repository (record 07). A session
 * starts from the chosen branch and pushes to a new `oncue/` branch, or works
 * directly on an existing branch and pushes there. The list is read when the
 * control opens; the Worker reads the chosen branch from GitHub again at
 * creation and refuses the default branch, a protected one, or one another
 * session holds, so this is not a security boundary.
 *
 * A popover rather than a menu: it holds a search field, which a menu's
 * typeahead would fight.
 */
import { Check, ChevronsUpDown, GitBranch, Lock } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type BranchSummary, type ListBranchesResult, listBranches } from "@/lib/api/branches";
import type { BranchMode } from "@/lib/api/sessions";
import { cn } from "@/lib/utils";

export interface BranchChoice {
  /** Null for the repository's default branch. */
  readonly name: string | null;
  readonly mode: BranchMode;
}

export const DEFAULT_BRANCH_CHOICE: BranchChoice = { name: null, mode: "new_branch" };

/** How long typing pauses before the list is asked for again. */
export const SEARCH_DEBOUNCE_MS = 200;

/** Why a branch cannot be worked on directly, as the row says it; null when it can. */
export function workRefusal(branch: BranchSummary): string | null {
  if (branch.default) {
    return "Default branch";
  }
  if (branch.protected) {
    return "Protected";
  }
  return null;
}

/**
 * The choice after a mode switch. Working directly cannot keep a branch the
 * listing shows as the default or protected, so it starts with none chosen.
 */
export function switchMode(
  choice: BranchChoice,
  mode: BranchMode,
  result: ListBranchesResult | null,
): BranchChoice {
  if (mode !== "existing_branch" || choice.name === null || result?.kind !== "listed") {
    return { name: choice.name, mode };
  }
  const listed = result.branches.find((branch) => branch.name === choice.name);
  return { name: listed !== undefined && workRefusal(listed) !== null ? null : choice.name, mode };
}

/** How long a listing is reused for the same repository and search. */
export const LISTING_FRESH_MS = 60_000;

const listings = new Map<
  string,
  { readonly at: number; readonly result: Promise<ListBranchesResult> }
>();

/**
 * `listBranches`, with an answer reused for a minute per repository and
 * search: one listing costs GitHub up to six calls, so reopening the control or
 * retyping a search does not ask again. A failed listing is not kept.
 */
export function cachedListBranches(
  repositoryConnectionId: string,
  query: string,
  now: number = Date.now(),
): Promise<ListBranchesResult> {
  const key = `${repositoryConnectionId}\n${query.trim()}`;
  const kept = listings.get(key);
  if (kept !== undefined && now - kept.at < LISTING_FRESH_MS) {
    return kept.result;
  }
  const result = listBranches(repositoryConnectionId, query).then((answer) => {
    if (answer.kind !== "listed") {
      listings.delete(key);
    }
    return answer;
  });
  listings.set(key, { at: now, result });
  return result;
}

/** Forgets every kept listing; tests start from none. */
export function forgetBranchListings(): void {
  listings.clear();
}

/** What the control says: the branch, and whether the session pushes there. */
export function choiceLabel(choice: BranchChoice): string {
  if (choice.mode === "existing_branch") {
    return choice.name === null ? "Pick a branch to work on" : `On ${choice.name}`;
  }
  return choice.name === null ? "Default branch" : `From ${choice.name}`;
}

export interface BranchPickerProps {
  readonly repositoryConnectionId: string | null;
  readonly choice: BranchChoice;
  readonly onChange: (choice: BranchChoice) => void;
  readonly disabled?: boolean;
  /** The list read; tests pass their own. */
  readonly load?: (repositoryConnectionId: string, query: string) => Promise<ListBranchesResult>;
}

/** In the composer's bar the branch shrinks after the repository has, down to its own floor. */
const CONTROL =
  "flex min-w-[min(3.25rem,15cqi)] items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] transition-colors disabled:opacity-60 @max-[400px]/strip:px-1.5";

const MODES: ReadonlyArray<{ readonly mode: BranchMode; readonly label: string }> = [
  { mode: "new_branch", label: "New branch from it" },
  { mode: "existing_branch", label: "Work on it directly" },
];

export function BranchPicker({
  repositoryConnectionId,
  choice,
  onChange,
  disabled = false,
  load = cachedListBranches,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Kept with the repository it lists, so another repository's branches are never shown.
  const [answer, setAnswer] = useState<{
    readonly repositoryConnectionId: string;
    readonly result: ListBranchesResult;
  } | null>(null);
  const searchId = useId();
  const modeName = useId();
  // The latest ask wins, so a slow answer to an older search never replaces a newer one.
  const asked = useRef(0);

  useEffect(() => {
    if (!open || repositoryConnectionId === null) {
      return;
    }
    const ask = asked.current + 1;
    asked.current = ask;
    const timer = setTimeout(
      () => {
        void load(repositoryConnectionId, query).then((result) => {
          if (asked.current === ask) {
            setAnswer({ repositoryConnectionId, result });
          }
        });
      },
      query.length === 0 ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [open, repositoryConnectionId, query, load]);

  if (repositoryConnectionId === null) {
    return null;
  }

  const result = answer?.repositoryConnectionId === repositoryConnectionId ? answer.result : null;
  const existing = choice.mode === "existing_branch";
  const pick = (branch: BranchSummary) => {
    // The default branch is named by its absence, as every older session was.
    onChange({ name: branch.default ? null : branch.name, mode: choice.mode });
    setOpen(false);
  };
  // With no name, a new branch starts from the default; working directly has
  // nothing chosen yet.
  const selectedName = (branch: BranchSummary) =>
    choice.name === null ? branch.default && !existing : branch.name === choice.name;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        data-testid="branch-picker"
        aria-label={`Branch: ${choiceLabel(choice)}. Choose a different one`}
        className={cn(CONTROL, "text-text hover:bg-hover")}
      >
        <GitBranch className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 max-w-[200px] truncate" data-testid="branch-picker-label">
          {choiceLabel(choice)}
        </span>
        <ChevronsUpDown
          className="@max-[400px]/strip:hidden size-3.5 shrink-0 text-faint"
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-[300px] p-1.5"
        data-testid="branch-picker-panel"
      >
        <fieldset className="flex gap-1">
          <legend className="sr-only">What the session does with the branch</legend>
          {MODES.map((option) => (
            <label
              key={option.mode}
              className={cn(
                "flex flex-1 cursor-pointer items-center justify-center rounded-md px-2 py-1 text-[12px] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-accent",
                choice.mode === option.mode
                  ? "bg-hover-strong text-text"
                  : "text-muted-foreground hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name={modeName}
                value={option.mode}
                checked={choice.mode === option.mode}
                data-testid={`branch-mode-${option.mode}`}
                onChange={() => onChange(switchMode(choice, option.mode, result))}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p className="px-1.5 pt-1.5 text-[11.5px] text-muted-foreground">
          {existing
            ? "The session pushes to this branch and adopts its open pull request."
            : "The session starts here and pushes to a new oncue/ branch."}
        </p>
        <label htmlFor={searchId} className="sr-only">
          Find a branch
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a branch"
          data-testid="branch-search"
          className="mt-1.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="scroll-pill mt-1 max-h-[228px] overflow-y-auto overscroll-contain">
          <BranchRows result={result} existing={existing} selected={selectedName} onPick={pick} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BranchRows({
  result,
  existing,
  selected,
  onPick,
}: {
  readonly result: ListBranchesResult | null;
  readonly existing: boolean;
  readonly selected: (branch: BranchSummary) => boolean;
  readonly onPick: (branch: BranchSummary) => void;
}) {
  const note = "px-2 py-1.5 text-[12px] text-muted-foreground";
  if (result === null) {
    return <p className={note}>Loading branches…</p>;
  }
  if (result.kind === "reconnect_github") {
    return <p className={note}>Reconnect GitHub to list this repository's branches.</p>;
  }
  if (result.kind !== "listed") {
    return <p className={note}>OnCue couldn't list the branches. Try again in a moment.</p>;
  }
  if (result.branches.length === 0) {
    return <p className={note}>No branch matches.</p>;
  }
  return (
    <>
      <ul className="space-y-px" data-testid="branch-options">
        {result.branches.map((branch) => {
          const refusal = existing ? workRefusal(branch) : null;
          return (
            <li key={branch.name}>
              {/*
                Refused rows stay focusable with `aria-disabled`, so keyboard and
                screen-reader users reach the reason, which the row's name includes.
              */}
              <button
                type="button"
                aria-disabled={refusal !== null}
                aria-pressed={selected(branch)}
                data-testid="branch-option"
                data-branch={branch.name}
                onClick={() => {
                  if (refusal === null) {
                    onPick(branch);
                  }
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-text hover:bg-hover aria-disabled:cursor-not-allowed aria-disabled:text-faint aria-disabled:hover:bg-transparent"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{branch.name}</span>
                {branch.protected ? (
                  <Lock className="size-3 shrink-0 text-faint" aria-label="Protected" />
                ) : null}
                {refusal !== null ? (
                  <span className="shrink-0 text-[11px] text-faint">{refusal}</span>
                ) : branch.default ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">default</span>
                ) : null}
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {selected(branch) ? <Check className="size-3.5" aria-hidden="true" /> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {result.truncated ? (
        <p className={note}>Showing the first branches. Type a name to find another.</p>
      ) : null}
    </>
  );
}
