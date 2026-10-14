/**
 * One file's section in the review panel: a sticky header, then its hunks.
 * Every line is untrusted sandbox text rendered as a text node. Added and
 * removed lines carry a `+` or `-` so colour is never the only signal.
 */
import type { FileChange } from "@oncue/protocol";
import type { Ref } from "react";
import { cn } from "@/lib/utils";
import { ChangeCounts, DimmedPath } from "./ChangeCard";
import { type DiffLine, diffRows, type ParsedDiffFile } from "./parse-unified-diff";

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  added: "border-positive bg-positive/10",
  removed: "border-danger bg-danger/10",
  context: "border-transparent",
};

const SIGN: Record<DiffLine["kind"], string> = { added: "+", removed: "-", context: " " };

function unmodifiedWords(count: number): string {
  return count === 1 ? "1 unmodified line" : `${count} unmodified lines`;
}

export function DiffFileView({
  change,
  parsed,
  ref,
}: {
  change: FileChange;
  parsed: ParsedDiffFile | undefined;
  ref?: Ref<HTMLElement> | undefined;
}) {
  const rows = parsed === undefined ? [] : diffRows(parsed);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={change.path}
      data-testid="diff-file"
      data-diff-path={change.path}
      className="border-border border-b outline-none last:border-b-0"
    >
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-border-soft border-b bg-panel px-3 py-1.5 text-[12px]">
        <DimmedPath path={change.path} className="font-mono" />
        <ChangeCounts additions={change.additions} deletions={change.deletions} />
      </header>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-faint">
          {parsed?.binary === true ? "Binary file, not shown." : "No line changes to show."}
        </p>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must take focus so a keyboard can scroll it (WCAG 2.1.1)
        <div className="overflow-x-auto" tabIndex={0}>
          <div className="w-max min-w-full font-mono text-[12px] leading-5">
            {rows.map((row) =>
              row.kind === "gap" ? (
                <div
                  key={row.key}
                  data-testid="diff-gap"
                  className="bg-hover px-3 py-0.5 text-center font-sans text-[11px] text-text/70"
                >
                  {unmodifiedWords(row.count)}
                </div>
              ) : (
                <div
                  key={row.key}
                  data-testid="diff-line"
                  data-kind={row.line.kind}
                  className={cn("flex border-l-2 pr-3", LINE_CLASS[row.line.kind])}
                >
                  <span
                    className="w-10 shrink-0 select-none pr-1.5 text-right text-text/70 tabular-nums"
                    aria-hidden="true"
                  >
                    {row.line.oldNumber ?? ""}
                  </span>
                  <span
                    className="w-10 shrink-0 select-none pr-1.5 text-right text-text/70 tabular-nums"
                    aria-hidden="true"
                  >
                    {row.line.newNumber ?? ""}
                  </span>
                  <span
                    className={cn(
                      "w-4 shrink-0 select-none text-center",
                      row.line.kind === "added"
                        ? "text-positive"
                        : row.line.kind === "removed"
                          ? "text-danger"
                          : "text-faint",
                    )}
                  >
                    {SIGN[row.line.kind]}
                  </span>
                  <span className="whitespace-pre text-text">{row.line.text}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </section>
  );
}
