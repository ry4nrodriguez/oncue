/**
 * Copies the turn's assistant messages as markdown, with code fenced, and
 * shows a check briefly when done.
 */
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const COPIED_FOR_MS = 1500;

/**
 * The async clipboard first, then the selection-based command, which still
 * works where page scripts are denied the clipboard. Returns whether either worked.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the command.
  }
  const holder = document.createElement("textarea");
  holder.value = text;
  holder.setAttribute("readonly", "");
  holder.style.position = "fixed";
  holder.style.opacity = "0";
  document.body.append(holder);
  holder.select();
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  holder.remove();
  return done;
}

export function CopyResponse({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (await writeClipboard(text)) {
      setCopied(true);
    }
    // A blocked clipboard leaves the button unchanged.
  }

  return (
    <div className="flex justify-start py-1">
      <button
        type="button"
        data-testid="copy-response"
        data-copied={copied ? "true" : "false"}
        aria-label={copied ? "Copied" : "Copy response"}
        title={copied ? "Copied" : "Copy response"}
        onClick={() => void copy()}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-text"
      >
        {copied ? (
          <Check className="size-4 text-positive" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
