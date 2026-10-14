/**
 * Makes untrusted text (the agent's pull request title and body, check names,
 * run warnings) safe for a GitHub page, so it cannot notify people, cross-link
 * issues, or hide text.
 *
 * GitHub finds mentions and references in the rendered text, so a backslash
 * escape or entity that renders as `@` still notifies. Each run of text is
 * decoded, the tokens GitHub would act on are put in code spans, and the rest
 * is written back with its escapes.
 *
 * `defuseMarkdown` (description), `defuseTitle`, `plainMarkdownLine`
 * (verification warnings), and `codeSpanText` (check names) all strip control
 * and format characters and are idempotent.
 */

/** ASCII punctuation: the characters a CommonMark backslash escapes. */
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const WORD_CHARACTER = /^[A-Za-z0-9_]$/;

// Control, format (bidi overrides, zero-width), private-use, and lone
// surrogate characters: none is honest text, and format characters can make
// text read other than it is.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;

/** A carriage return, NEL, and the line and paragraph separators are all line breaks. */
const LINE_BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;

/** A named, decimal, or hexadecimal character reference, which GitHub decodes (`&commat;` renders `@`). Sticky: tested where an `&` is. */
const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/y;

/** Punctuation a URL does not end on (GitHub's autolink rule, roughly). */
const URL_TRAILING = /[.,;:!?)\]}'"*_~]+$/;

/** A link into GitHub itself: a profile, an issue, a pull request, a discussion, a commit. */
const GITHUB_URL = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[A-Za-z0-9-]+\.)*github\.com(?:[/:?#]|$)/i;

const URL_SOURCE = String.raw`(?<url>(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s<>|\`\\"']+)`;
const EMAIL_SOURCE = String.raw`(?<email>[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)`;
const MENTION_SOURCE = String.raw`(?<mention>@[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_.-]+)?)`;
const REFERENCE_SOURCE = String.raw`(?<reference>(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[0-9]+|GH-[0-9]+)`;

interface Mode {
  /** Whether `\X` is an escape. A Markdown body: yes. A title: no. */
  readonly backslashEscapes: boolean;
  /** A backtick that opens no code span: escaped in Markdown, dropped from a title. */
  readonly strayBacktick: "escape" | "drop";
  /** Whether a URL becomes code. If not, it is written back as it is and nothing inside it is a token. */
  readonly wrapUrl: (url: string) => boolean;
  /** The tokens, as a regular expression source; see `atomsFor`. */
  readonly atoms: string;
  /** Characters written back with a backslash wherever they are. */
  readonly escaped: ReadonlySet<string>;
  /** Whether `<` and `&` are escaped where they would start HTML or a character reference. */
  readonly escapeHtml: boolean;
}

const toGitHub = (url: string): boolean => GITHUB_URL.test(url);
const MARKDOWN_ATOMS = [URL_SOURCE, MENTION_SOURCE, REFERENCE_SOURCE].join("|");

const MARKDOWN_MODE: Mode = {
  backslashEscapes: true,
  strayBacktick: "escape",
  wrapUrl: toGitHub,
  atoms: MARKDOWN_ATOMS,
  escaped: new Set(),
  escapeHtml: true,
};

const TITLE_MODE: Mode = {
  backslashEscapes: false,
  strayBacktick: "drop",
  wrapUrl: toGitHub,
  atoms: MARKDOWN_ATOMS,
  escaped: new Set(),
  escapeHtml: false,
};

const PLAIN_MODE: Mode = {
  backslashEscapes: true,
  strayBacktick: "escape",
  wrapUrl: () => true,
  atoms: [URL_SOURCE, EMAIL_SOURCE, MENTION_SOURCE, REFERENCE_SOURCE].join("|"),
  // A link or an image (`[`, `]`, `!`), emphasis, a table's pipe, a heading.
  escaped: new Set(["[", "]", "!", "*", "_", "~", "|", "#"]),
  escapeHtml: true,
};

/** Control and format characters out, every line break a `\n`. Tabs stay: Markdown indents with them. */
export function stripInvisible(text: string): string {
  return text
    .replace(LINE_BREAKS, "\n")
    .replace(INVISIBLE, (character) => (character === "\n" || character === "\t" ? character : ""));
}

/** Every `<!--` and `-->` out, again until none is left, so `<!-<!---->-` cannot reassemble one. */
export function withoutCommentMarkers(text: string): string {
  let current = text;
  let previous: string;
  do {
    previous = current;
    current = current.replace(/<!--|-->/g, "");
  } while (current !== previous);
  return current;
}

interface Piece {
  readonly code: boolean;
  readonly text: string;
}

function backtickRun(line: string, at: number): number {
  let end = at;
  while (line[end] === "`") {
    end += 1;
  }
  return end - at;
}

/** Where each maximal run of backticks of each length starts, in order. */
function runStarts(line: string): ReadonlyMap<number, readonly number[]> {
  const starts = new Map<number, number[]>();
  let at = 0;
  while (at < line.length) {
    if (line[at] === "`") {
      const length = backtickRun(line, at);
      const list = starts.get(length);
      if (list === undefined) {
        starts.set(length, [at]);
      } else {
        list.push(at);
      }
      at += length;
    } else {
      at += 1;
    }
  }
  return starts;
}

/** The first run of exactly `length` backticks starting at or after `from`, or -1. */
function closingRun(
  starts: ReadonlyMap<number, readonly number[]>,
  length: number,
  from: number,
): number {
  const candidates = starts.get(length) ?? [];
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((candidates[middle] as number) < from) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < candidates.length ? (candidates[low] as number) : -1;
}

/**
 * A line cut into code spans and text by CommonMark's rule: N backticks open a
 * span only if a later run of exactly N closes it. Spans are looked for on one
 * line only; an unmatched backtick is escaped, so it cannot pair with a span
 * added here.
 */
function splitCodeSpans(line: string, backslashEscapes: boolean): readonly Piece[] {
  const starts = runStarts(line);
  const pieces: Piece[] = [];
  let textStart = 0;
  let at = 0;
  while (at < line.length) {
    const character = line[at] as string;
    if (backslashEscapes && character === "\\" && ASCII_PUNCTUATION.test(line[at + 1] ?? "")) {
      at += 2;
      continue;
    }
    if (character !== "`") {
      at += 1;
      continue;
    }
    const length = backtickRun(line, at);
    const close = closingRun(starts, length, at + length);
    if (close === -1) {
      at += length;
      continue;
    }
    pieces.push({ code: false, text: line.slice(textStart, at) });
    pieces.push({ code: true, text: line.slice(at, close + length) });
    at = close + length;
    textStart = at;
  }
  pieces.push({ code: false, text: line.slice(textStart) });
  return pieces;
}

interface Glyph {
  readonly character: string;
  /** Written with a backslash in the source, so it renders as itself. */
  readonly escaped: boolean;
}

function decode(text: string, mode: Mode): readonly Glyph[] {
  const glyphs: Glyph[] = [];
  let at = 0;
  while (at < text.length) {
    const character = text[at] as string;
    const next = text[at + 1] ?? "";
    if (mode.backslashEscapes && character === "\\" && ASCII_PUNCTUATION.test(next)) {
      glyphs.push({ character: next, escaped: true });
      at += 2;
    } else {
      glyphs.push({ character, escaped: false });
      at += 1;
    }
  }
  return glyphs;
}

function startsEntity(rendered: string, at: number): boolean {
  ENTITY.lastIndex = at;
  return ENTITY.test(rendered);
}

/** Glyphs written back so they render as themselves, with this mode's dangerous characters escaped. */
function encode(glyphs: readonly Glyph[], rendered: string, offset: number, mode: Mode): string {
  let out = "";
  glyphs.forEach((glyph, index) => {
    const { character } = glyph;
    if (character === "`") {
      out += mode.strayBacktick === "escape" ? "\\`" : "";
      return;
    }
    if (!mode.backslashEscapes) {
      out += character;
      return;
    }
    const at = offset + index;
    const needsEscape =
      character === "\\" ||
      glyph.escaped ||
      mode.escaped.has(character) ||
      (mode.escapeHtml && character === "<" && /^[A-Za-z/!?]$/.test(rendered[at + 1] ?? "")) ||
      (mode.escapeHtml && character === "&" && startsEntity(rendered, at));
    out += needsEscape ? `\\${character}` : character;
  });
  return out;
}

/**
 * A run of text outside code, with every token GitHub would act on put in a
 * code span. GitHub treats text right after a code span as a word start, so
 * the boundary check restarts after each token wrapped here.
 */
function defuseRun(text: string, mode: Mode): readonly string[] {
  const glyphs = decode(text, mode);
  const rendered = glyphs.map((glyph) => glyph.character).join("");
  const atoms = new RegExp(mode.atoms, "gi");
  const parts: string[] = [];
  let at = 0;
  let match = atoms.exec(rendered);
  while (match !== null) {
    const start = match.index;
    const groups = match.groups as Record<string, string | undefined>;
    const url = groups.url;
    const needsBoundary = url === undefined && groups.email === undefined;
    if (needsBoundary && start > at && WORD_CHARACTER.test(rendered[start - 1] as string)) {
      atoms.lastIndex = start + 1;
      match = atoms.exec(rendered);
      continue;
    }
    const token = url === undefined ? match[0] : url.replace(URL_TRAILING, "");
    const end = start + token.length;
    const before = encode(glyphs.slice(at, start), rendered, at, mode);
    if (url !== undefined && !mode.wrapUrl(token)) {
      // An ordinary link stays a link, and nothing inside it is a token.
      parts.push(before, encode(glyphs.slice(start, end), rendered, start, mode));
    } else {
      // A link into GitHub written as a Markdown link's destination, `[x](url)`,
      // or a reference definition's, `[x]: url`, would still link through the
      // code span's backticks, so the `(` or `]` that makes it one is escaped.
      parts.push(
        mode.backslashEscapes && url !== undefined
          ? before.replace(/(?<!\\)\((\s*)$/, "\\($1").replace(/(?<!\\)\]:(\s*)$/, "\\]:$1")
          : before,
        `\`${token}\``,
      );
    }
    at = end;
    atoms.lastIndex = end;
    match = atoms.exec(rendered);
  }
  parts.push(encode(glyphs.slice(at), rendered, at, mode));
  return parts;
}

/**
 * Parts joined, with a space where a code span added here would otherwise
 * touch a backtick, and so pair differently, or follow a backslash that would
 * escape its opener.
 */
function join(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (part.startsWith("`") && (out.endsWith("`") || out.endsWith("\\"))) {
      out += " ";
    }
    out += part;
  }
  return out;
}

function defuseLine(line: string, mode: Mode): string {
  const parts: string[] = [];
  for (const piece of splitCodeSpans(line, mode.backslashEscapes)) {
    if (piece.code) {
      parts.push(piece.text);
    } else {
      parts.push(...defuseRun(piece.text, mode));
    }
  }
  return join(parts);
}

interface Fence {
  readonly marker: string;
  readonly length: number;
}

/** A line that opens a fenced code block: up to three spaces, three or more of one mark; a backtick fence's info has no backtick. */
function fenceOpening(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) {
    return null;
  }
  const run = match[1] as string;
  if (run.startsWith("`") && (match[2] as string).includes("`")) {
    return null;
  }
  return { marker: run[0] as string, length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const run = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1] ?? "";
  return run.startsWith(fence.marker) && run.length >= fence.length;
}

/**
 * The agent's Markdown description, kept as Markdown. Inside a fenced code
 * block nothing changes, because GitHub acts on nothing there; an unclosed
 * fence runs to the end, as it does on GitHub.
 */
export function defuseMarkdown(markdown: string): string {
  let fence: Fence | null = null;
  const lines = withoutCommentMarkers(stripInvisible(markdown)).split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (fence !== null) {
      fence = closesFence(line, fence) ? null : fence;
      out.push(line);
      continue;
    }
    fence = fenceOpening(line);
    out.push(fence === null ? defuseLine(line, MARKDOWN_MODE) : line);
  }
  return out.join("\n").trim();
}

/** One line, whitespace collapsed. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A title: one line, no marker of ours, and nothing in it that links a person or an issue. */
export function defuseTitle(title: string): string {
  return oneLine(defuseLine(oneLine(withoutCommentMarkers(stripInvisible(title))), TITLE_MODE));
}

/** The first `count` code points, so a cut never splits a surrogate pair. */
function firstCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

function plainOnce(flat: string): string {
  // Text that starts like a list or an ordered list would open one inside the
  // list item the line is written into.
  return defuseLine(flat, PLAIN_MODE)
    .replace(/^([-+])/, "\\$1")
    .replace(/^([0-9]{1,9})([.)])/, "$1\\$2");
}

/**
 * One line of plain words, at most `maxChars` characters as written. Angle
 * brackets are removed so no marker of ours can be spelled.
 */
export function plainMarkdownLine(text: string, maxChars: number): string {
  const flat = oneLine(stripInvisible(text).replace(/[<>]/g, ""));
  let keep = Array.from(flat).length;
  let line = plainOnce(flat);
  while (line.length > maxChars) {
    // Escapes, code spans, and surrogate pairs make the written text longer
    // than the code points it came from; cutting half the excess each time
    // gets under the bound without cutting much more than it needs.
    keep = Math.max(0, keep - Math.max(1, Math.ceil((line.length - maxChars) / 2)));
    line = plainOnce(firstCodePoints(flat, keep).trim());
  }
  return line;
}

/**
 * Text for inside a code span: one line with no backtick (the span cannot
 * close early) and no angle bracket; at most `maxChars` code points.
 */
export function codeSpanText(text: string, maxChars: number): string {
  return firstCodePoints(oneLine(stripInvisible(text).replace(/[`<>]/g, "")), maxChars).trim();
}
