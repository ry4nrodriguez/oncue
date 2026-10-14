/**
 * A pure parser for the inline unified patch in `diff.updated`. The patch is
 * untrusted sandbox text, so this only splits and numbers lines, and the panel
 * renders each as a text node. Hunks are read by their line counts, so a
 * removed line starting "-- " is never taken for a header. Unrecognised input
 * is skipped rather than thrown on.
 */

export type DiffLineKind = "context" | "added" | "removed";

export type DiffLine = {
  readonly kind: DiffLineKind;
  /** The line's number in the old file; `null` for an added line. */
  readonly oldNumber: number | null;
  /** The line's number in the new file; `null` for a removed line. */
  readonly newNumber: number | null;
  readonly text: string;
  /** Git's "\ No newline at end of file" followed this line. */
  readonly noNewlineAtEnd: boolean;
};

export type DiffHunk = {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** The text after the second `@@`, usually the enclosing function. */
  readonly section: string;
  readonly lines: readonly DiffLine[];
};

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export type ParsedDiffFile = {
  /** The path the file has after the change, or before it when it was deleted. */
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  readonly additions: number;
  readonly deletions: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

const C_ESCAPES: Record<string, string> = {
  a: String.fromCharCode(7),
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/**
 * Git quotes a path holding unusual bytes as a C string with octal escapes.
 * The escapes are decoded to their bytes and read as UTF-8; anything that is
 * not a quoted path is returned as it came.
 */
export function unquotePath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = body[index + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const escaped = C_ESCAPES[next];
    bytes.push(...encoder.encode(escaped ?? next));
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** `a/src/x.ts` to `src/x.ts`; `/dev/null` to `null`. */
function stripPrefix(raw: string): string | null {
  const path = unquotePath(raw.trim());
  if (path === "/dev/null") {
    return null;
  }
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

/**
 * The two paths of a `diff --git a/x b/y` line. Unless quoted or equal, the
 * split is at the last " b/", which is wrong only for paths containing " b/".
 */
function gitHeaderPaths(rest: string): { oldPath: string | null; newPath: string | null } {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (quoted !== null && rest.includes('"')) {
    return { oldPath: stripPrefix(quoted[1] as string), newPath: stripPrefix(quoted[2] as string) };
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(0, half).slice(2) === rest.slice(half + 1).slice(2)) {
    return {
      oldPath: stripPrefix(rest.slice(0, half)),
      newPath: stripPrefix(rest.slice(half + 1)),
    };
  }
  const split = rest.lastIndexOf(" b/");
  if (split > 0) {
    return {
      oldPath: stripPrefix(rest.slice(0, split)),
      newPath: stripPrefix(rest.slice(split + 1)),
    };
  }
  return { oldPath: stripPrefix(rest), newPath: stripPrefix(rest) };
}

type Draft = {
  oldPath: string | null;
  newPath: string | null;
  created: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

function emptyDraft(): Draft {
  return {
    oldPath: null,
    newPath: null,
    created: false,
    deleted: false,
    renamed: false,
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

function finish(draft: Draft): ParsedDiffFile | null {
  const path = draft.newPath ?? draft.oldPath;
  if (path === null) {
    return null;
  }
  const status: DiffFileStatus =
    draft.created || draft.oldPath === null
      ? "added"
      : draft.deleted || draft.newPath === null
        ? "deleted"
        : draft.renamed || draft.oldPath !== draft.newPath
          ? "renamed"
          : "modified";
  return {
    path,
    oldPath: draft.oldPath,
    newPath: draft.newPath,
    status,
    binary: draft.binary,
    hunks: draft.hunks,
    additions: draft.additions,
    deletions: draft.deletions,
  };
}

export function parseUnifiedDiff(patch: string): readonly ParsedDiffFile[] {
  const lines = patch.split("\n");
  // A trailing newline splits into an empty string that is not a patch line.
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const files: ParsedDiffFile[] = [];
  let draft: Draft | null = null;
  // A second `---`/`+++` pair (a patch without `diff --git` lines) starts the next file.
  let sawHeaders = false;

  const close = () => {
    if (draft !== null) {
      const file = finish(draft);
      if (file !== null) {
        files.push(file);
      }
    }
    draft = null;
    sawHeaders = false;
  };

  let index = 0;
  while (index < lines.length) {
    const line = (lines[index] as string).replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      close();
      draft = emptyDraft();
      const paths = gitHeaderPaths(line.slice("diff --git ".length));
      draft.oldPath = paths.oldPath;
      draft.newPath = paths.newPath;
      index += 1;
      continue;
    }

    if (line.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ")) {
      if (draft === null || sawHeaders || draft.hunks.length > 0) {
        close();
        draft = emptyDraft();
      }
      const current = draft as Draft;
      current.oldPath = stripPrefix(line.slice(4).split("\t")[0] as string);
      current.newPath = stripPrefix(
        ((lines[index + 1] as string).replace(/\r$/, "").slice(4).split("\t")[0] ?? "") as string,
      );
      sawHeaders = true;
      index += 2;
      continue;
    }

    const current = draft as Draft | null;
    if (current === null) {
      index += 1;
      continue;
    }

    if (line.startsWith("new file mode")) {
      current.created = true;
    } else if (line.startsWith("deleted file mode")) {
      current.deleted = true;
    } else if (line.startsWith("rename from ")) {
      current.renamed = true;
      current.oldPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.renamed = true;
      current.newPath = unquotePath(line.slice("rename to ".length));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
    }

    const header = HUNK_HEADER.exec(line);
    if (header === null) {
      index += 1;
      continue;
    }

    const oldStart = Number(header[1]);
    const oldLines = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newLines = header[4] === undefined ? 1 : Number(header[4]);
    let oldLeft = oldLines;
    let newLeft = newLines;
    let oldNumber = oldStart;
    let newNumber = newStart;
    const hunkLines: DiffLine[] = [];
    index += 1;
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const body = (lines[index] as string).replace(/\r$/, "");
      const mark = body[0];
      const text = body.slice(1);
      if (mark === "\\") {
        const last = hunkLines.pop();
        if (last !== undefined) {
          hunkLines.push({ ...last, noNewlineAtEnd: true });
        }
      } else if (mark === "+" && newLeft > 0) {
        hunkLines.push({
          kind: "added",
          oldNumber: null,
          newNumber,
          text,
          noNewlineAtEnd: false,
        });
        newNumber += 1;
        newLeft -= 1;
        current.additions += 1;
      } else if (mark === "-" && oldLeft > 0) {
        hunkLines.push({
          kind: "removed",
          oldNumber,
          newNumber: null,
          text,
          noNewlineAtEnd: false,
        });
        oldNumber += 1;
        oldLeft -= 1;
        current.deletions += 1;
      } else if ((mark === " " || body === "") && oldLeft > 0 && newLeft > 0) {
        // Some tools strip the single space from an empty context line.
        hunkLines.push({ kind: "context", oldNumber, newNumber, text, noNewlineAtEnd: false });
        oldNumber += 1;
        newNumber += 1;
        oldLeft -= 1;
        newLeft -= 1;
      } else {
        // A line the counts do not allow: the hunk is shorter than it claimed.
        break;
      }
      index += 1;
    }
    // A trailing "\ No newline" belongs to the hunk just read.
    if ((lines[index] ?? "").startsWith("\\")) {
      const last = hunkLines.pop();
      if (last !== undefined) {
        hunkLines.push({ ...last, noNewlineAtEnd: true });
      }
      index += 1;
    }
    current.hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      section: header[5] ?? "",
      lines: hunkLines,
    });
  }
  close();
  return files;
}

/** Every line across every hunk of every file, as the render limit counts them. */
export function countDiffLines(files: readonly ParsedDiffFile[]): number {
  let total = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      total += hunk.lines.length;
    }
  }
  return total;
}

export type DiffRow =
  | { readonly kind: "gap"; readonly count: number; readonly key: string }
  | { readonly kind: "line"; readonly line: DiffLine; readonly key: string };

/**
 * A file's hunks as panel rows, with a gap row for each run of omitted lines
 * before and between hunks. The patch does not give the file's length, so no
 * gap row closes a file.
 */
export function diffRows(file: ParsedDiffFile): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  let nextNew = 1;
  file.hunks.forEach((hunk, hunkIndex) => {
    // A hunk that adds to an empty file starts at 0.
    const start = Math.max(hunk.newStart, 1);
    const gap = hunk.newLines === 0 ? hunk.newStart + 1 - nextNew : start - nextNew;
    if (gap > 0 && file.status !== "added") {
      rows.push({ kind: "gap", count: gap, key: `gap-${hunkIndex}` });
    }
    hunk.lines.forEach((line, lineIndex) => {
      rows.push({ kind: "line", line, key: `${hunkIndex}-${lineIndex}` });
    });
    nextNew = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart + hunk.newLines;
  });
  return rows;
}
