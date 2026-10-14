/**
 * A file the session left alone, read-only, as the base commit has it (record
 * 13). The Worker reads it from GitHub, so it shows while the sandbox is
 * stopped. The bytes are untrusted, so text is drawn one text node per line
 * and never parsed as markup; other types, or files too large, offer a download.
 */
import { ArrowLeft, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchSessionFile, type SessionFileResult, sessionFileUrl } from "@/lib/api/sessions";
import { DimmedPath } from "./ChangeCard";

/** Past this many lines the view stops drawing and offers the whole file as a download. */
export const MAX_RENDERED_FILE_LINES = 5_000;

type Loaded = { readonly key: string; readonly result: SessionFileResult };

function useSessionFile(sessionId: string, path: string): SessionFileResult | null {
  const key = `${sessionId}\n${path}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchSessionFile(sessionId, path).then((result) => {
      if (!cancelled) {
        setLoaded({ key: `${sessionId}\n${path}`, result });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);
  return loaded !== null && loaded.key === key ? loaded.result : null;
}

/** An object URL for an image's bytes, released when the image goes. */
function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => (blob === null ? null : URL.createObjectURL(blob)), [blob]);
  useEffect(
    () => () => {
      if (url !== null) {
        URL.revokeObjectURL(url);
      }
    },
    [url],
  );
  return url;
}

/** "1.2 MB", "340 KB": a size a person reads, in decimal units as file browsers show them. */
export function sizeWords(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

function DownloadLink({ sessionId, path }: { sessionId: string; path: string }) {
  return (
    <a
      href={sessionFileUrl(sessionId, path, true)}
      download={path.slice(path.lastIndexOf("/") + 1)}
      className="inline-flex items-center gap-1 text-text underline underline-offset-2 hover:text-accent-text"
      data-testid="file-download"
    >
      <Download className="size-3.5" aria-hidden="true" />
      Download
    </a>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px] text-muted-foreground">
      {children}
    </div>
  );
}

function Body({
  sessionId,
  path,
  result,
}: {
  sessionId: string;
  path: string;
  result: SessionFileResult | null;
}) {
  const imageUrl = useObjectUrl(result?.kind === "image" ? result.blob : null);
  if (result === null) {
    return (
      <Note>
        <span role="status">Reading the file…</span>
      </Note>
    );
  }
  switch (result.kind) {
    case "text": {
      const lines = result.text.split("\n");
      if (lines.at(-1) === "") {
        lines.pop();
      }
      if (lines.length === 0) {
        return <Note>This file is empty.</Note>;
      }
      const shown = lines.slice(0, MAX_RENDERED_FILE_LINES);
      return (
        <>
          {lines.length > shown.length ? (
            <Note>
              <span>
                Showing the first {MAX_RENDERED_FILE_LINES.toLocaleString("en-US")} of{" "}
                {lines.length.toLocaleString("en-US")} lines.
              </span>
              <DownloadLink sessionId={sessionId} path={path} />
            </Note>
          ) : null}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must take focus so a keyboard can scroll it (WCAG 2.1.1) */}
          <div className="overflow-x-auto" tabIndex={0}>
            <div className="w-max min-w-full font-mono text-[12px] leading-5">
              {shown.map((line, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of one file at one commit never reorder
                  key={index}
                  data-testid="file-line"
                  className="flex border-transparent border-l-2 pr-3"
                >
                  <span
                    className="w-10 shrink-0 select-none pr-1.5 text-right text-text/70 tabular-nums"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span className="whitespace-pre pl-4 text-text">{line}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      );
    }
    case "image":
      return (
        <div className="p-3">
          {imageUrl === null ? null : (
            <img
              src={imageUrl}
              alt={path}
              data-testid="file-image"
              className="max-h-[70vh] max-w-full rounded border border-border-soft bg-surface object-contain"
            />
          )}
        </div>
      );
    case "binary":
      return (
        <Note>
          <span>Binary file, not shown.</span>
          <DownloadLink sessionId={sessionId} path={path} />
        </Note>
      );
    case "too_large":
      return (
        <Note>
          <span>
            Too large to preview{result.size === null ? "" : ` (${sizeWords(result.size)})`}.
          </span>
          <DownloadLink sessionId={sessionId} path={path} />
        </Note>
      );
    case "not_found":
      return <Note>This file is not in the commit the session started from.</Note>;
    case "not_a_file":
      return <Note>This is a link or a submodule, so there is nothing to show.</Note>;
    case "reconnect_github":
      return (
        <Note>GitHub needs to verify your access again. Reconnect GitHub, then try again.</Note>
      );
    case "unavailable":
      return <Note>OnCue couldn't read this file from GitHub. Try again in a moment.</Note>;
  }
}

export function FileContentView({
  sessionId,
  path,
  onBack,
}: {
  sessionId: string;
  path: string;
  /** Back to the diff. */
  onBack: () => void;
}) {
  const result = useSessionFile(sessionId, path);
  return (
    <section aria-label={path} data-testid="file-view" data-file-path={path}>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-border-soft border-b bg-panel px-2 py-1.5 text-[12px]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the changes"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-text"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </button>
        {/* The path keeps the row; the note gives way first in a narrow panel. */}
        <DimmedPath path={path} className="font-mono" />
        <span
          className="ml-auto min-w-0 shrink-[10] truncate text-faint"
          data-testid="file-view-note"
        >
          Unchanged in this session
        </span>
      </header>
      <Body sessionId={sessionId} path={path} result={result} />
    </section>
  );
}
