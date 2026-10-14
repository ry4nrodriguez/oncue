/**
 * The task branch's name, chosen at the first push (record 07). The `oncue/`
 * prefix is fixed because the push webhook and token narrowing recognise it;
 * the rest is editable, prefilled with a slug and four hex characters.
 */
import { BRANCH_PREFIX, isBranchName } from "@oncue/protocol";
import { useId } from "react";
import { cn } from "@/lib/utils";

export interface BranchNameFieldProps {
  /** The part after `oncue/`. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly className?: string | undefined;
}

/** The whole name the field stands for, or null while it is not one git would take. */
export function branchNameOf(value: string): string | null {
  const name = `${BRANCH_PREFIX}${value.trim()}`;
  return isBranchName(name) ? name : null;
}

export function BranchNameField({ value, onChange, className }: BranchNameFieldProps) {
  const id = useId();
  const valid = branchNameOf(value) !== null;
  return (
    <div className={cn("space-y-1", className)}>
      <label
        htmlFor={id}
        className="block text-[11px] text-muted-foreground uppercase tracking-wide"
      >
        Branch name
      </label>
      <div
        className={cn(
          "flex items-center rounded-md border bg-transparent font-mono text-[12px]",
          valid ? "border-border" : "border-danger",
        )}
      >
        <span className="select-none pl-2 text-muted-foreground">{BRANCH_PREFIX}</span>
        <input
          id={id}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!valid}
          data-testid="branch-name-input"
          className="min-w-0 flex-1 bg-transparent py-1 pr-2 text-text outline-none"
        />
      </div>
      {valid ? null : (
        <p className="text-[11px] text-danger" role="alert">
          Letters, digits, dots, dashes, and slashes; nothing else, and not empty.
        </p>
      )}
    </div>
  );
}
