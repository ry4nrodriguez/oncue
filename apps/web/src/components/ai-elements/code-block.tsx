// Derived from Vercel AI Elements (Copyright 2023 Vercel, Inc., Apache License 2.0)
// and changed for OnCue; see THIRD_PARTY_NOTICES.md at the repository root.
"use client";

import { type HTMLAttributes, useEffect, useState } from "react";
import { type BundledLanguage, bundledLanguages, codeToHtml, type ShikiTransformer } from "shiki";
import { cn } from "@/lib/utils";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  /** Any string: a language shiki does not bundle is shown as plain text. */
  language: string;
  showLineNumbers?: boolean;
};

/**
 * The bundled grammar a fence's language names, aliases included, or null.
 * The name comes from a model's message, so it is checked rather than cast.
 */
export function codeLanguage(language: string): BundledLanguage | null {
  const name = language.trim().toLowerCase();
  return Object.hasOwn(bundledLanguages, name) ? (name as BundledLanguage) : null;
}

const lineNumberTransformer: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.children.unshift({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "inline-block",
          "min-w-10",
          "mr-4",
          "text-right",
          "select-none",
          "text-muted-foreground",
        ],
      },
      children: [{ type: "text", value: String(line) }],
    });
  },
};

export async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false,
) {
  const transformers: ShikiTransformer[] = showLineNumbers ? [lineNumberTransformer] : [];

  return await Promise.all([
    codeToHtml(code, {
      lang: language,
      theme: "one-light",
      transformers,
    }),
    codeToHtml(code, {
      lang: language,
      theme: "one-dark-pro",
      transformers,
    }),
  ]);
}

const PLAIN_CLASS =
  "m-0 overflow-auto bg-background p-4 font-mono text-foreground text-sm whitespace-pre";

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  // Tagged with what it was made from, so a highlight of earlier code is never shown for new code.
  const [highlighted, setHighlighted] = useState<{
    readonly source: string;
    readonly light: string;
    readonly dark: string;
  } | null>(null);
  const grammar = codeLanguage(language);
  const source = `${grammar ?? ""}\u0000${showLineNumbers}\u0000${code}`;

  useEffect(() => {
    if (grammar === null) {
      return;
    }
    // Per run: an answer for a superseded input or an unmounted block is dropped.
    let current = true;
    highlightCode(code, grammar, showLineNumbers).then(
      ([light, dark]) => {
        if (current) {
          setHighlighted({ source, light, dark });
        }
      },
      () => {
        // A grammar that fails to load leaves the plain text in place.
      },
    );
    return () => {
      current = false;
    };
  }, [code, grammar, showLineNumbers, source]);

  const ready = highlighted !== null && highlighted.source === source ? highlighted : null;

  return (
    <div
      className={cn(
        "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
        className,
      )}
      data-code-block=""
      data-highlighted={ready === null ? "false" : "true"}
      {...props}
    >
      <div className="relative">
        {ready === null ? (
          // Plain until highlighted, and for good when it cannot be.
          <pre className={PLAIN_CLASS}>
            <code>{code}</code>
          </pre>
        ) : (
          <>
            <div
              className="overflow-auto dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki's output escapes the code it highlights.
              dangerouslySetInnerHTML={{ __html: ready.light }}
            />
            <div
              className="hidden overflow-auto dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki's output escapes the code it highlights.
              dangerouslySetInnerHTML={{ __html: ready.dark }}
            />
          </>
        )}
        {children && (
          <div className="absolute top-2 right-2 flex items-center gap-2">{children}</div>
        )}
      </div>
    </div>
  );
};
