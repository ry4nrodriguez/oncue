/**
 * A harness's mark (`components/brand/icons.tsx`). OpenCode and Pi have their
 * own, and Codex is OpenAI's, so it carries OpenAI's Blossom. Claude Code is
 * never listed (`harnessOptions` lists only what the image installs), so it
 * draws no mark.
 */
import type { RuntimeId } from "@oncue/protocol";
import { OpenAIMark, OpenCodeMark, PiMark } from "@/components/brand/icons";
import { cn } from "@/lib/utils";

function Mark({ id, className }: { id: RuntimeId; className: string }) {
  switch (id) {
    case "opencode":
      return <OpenCodeMark className={className} />;
    case "codex":
      return <OpenAIMark className={className} />;
    case "pi":
      return <PiMark className={className} />;
    case "claude":
      return null;
  }
}

/** `box` centres the mark in a square so names line up whatever the mark's shape. */
export function HarnessMark({
  id,
  className,
  box,
}: {
  id: RuntimeId;
  className: string;
  box?: string;
}) {
  if (box === undefined) {
    return <Mark id={id} className={className} />;
  }
  return (
    <span className={cn("flex shrink-0 items-center justify-center", box)}>
      <Mark id={id} className={className} />
    </span>
  );
}
