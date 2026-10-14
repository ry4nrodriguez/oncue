/**
 * The pure half of the change card and the review panel, so the panel's rules
 * are tested without rendering.
 */
import type { ArtifactRef, DiffView, FileChange, RunId, SessionView } from "@oncue/protocol";
import { countDiffLines, type ParsedDiffFile, parseUnifiedDiff } from "./parse-unified-diff";

/** Past this many diff lines the panel lists files and offers the download, to keep the DOM small. */
export const MAX_RENDERED_DIFF_LINES = 3_000;

/** "Last turn" is one run's `turn` diff; "All changes" is the session's `session` diff. */
export type ReviewScope = "turn" | "session";

export const SCOPE_LABELS: Record<ReviewScope, string> = {
  turn: "Last turn",
  session: "All changes",
};

/** The side panel's two review tabs. */
export type ReviewTab = "review" | "tests";

/** What the review panel opens on. `runId` null means the latest run; `path` is scrolled to. */
export type ReviewTarget = {
  readonly tab: ReviewTab;
  readonly scope: ReviewScope;
  readonly runId: RunId | null;
  readonly path?: string;
};

/** `app/page.tsx` to `{ directory: "app/", name: "page.tsx" }`. */
export function splitPath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/**
 * The run "Last turn" and the Tests tab show: the run the panel was opened
 * on, else the session's current run, else the last run that reported a diff.
 */
export function focusRunId(view: SessionView, runId: RunId | null): RunId | null {
  if (runId !== null) {
    return runId;
  }
  if (view.run !== null) {
    return view.run.runId;
  }
  return [...view.git.turnDiffs.keys()].at(-1) ?? null;
}

/**
 * The diff a scope shows. "Last turn" falls back from the focused run to the
 * last turn diff reported, so a run that changed nothing (a question, say)
 * does not hide the turn before it.
 */
export function diffForScope(
  view: SessionView,
  scope: ReviewScope,
  runId: RunId | null,
): DiffView | null {
  if (scope === "session") {
    return view.git.sessionDiff;
  }
  const focused = focusRunId(view, runId);
  const own = focused === null ? undefined : view.git.turnDiffs.get(focused);
  return own ?? [...view.git.turnDiffs.values()].at(-1) ?? null;
}

export type DiffBody =
  | { readonly kind: "lines"; readonly files: ReadonlyMap<string, ParsedDiffFile> }
  | { readonly kind: "too_large"; readonly artifact: ArtifactRef | null };

/**
 * Whether the panel draws the diff line by line. An artifact body, a truncated
 * patch, or too many lines fall back to the file list and a download.
 */
export function diffBody(diff: DiffView): DiffBody {
  if (diff.body.kind === "artifact") {
    return { kind: "too_large", artifact: diff.body.artifact };
  }
  if (diff.truncated) {
    return { kind: "too_large", artifact: null };
  }
  const parsed = parseUnifiedDiff(diff.body.patch);
  if (countDiffLines(parsed) > MAX_RENDERED_DIFF_LINES) {
    return { kind: "too_large", artifact: null };
  }
  return { kind: "lines", files: new Map(parsed.map((file) => [file.path, file])) };
}

export type TreeNode =
  | {
      readonly kind: "folder";
      readonly path: string;
      readonly name: string;
      readonly children: readonly TreeNode[];
      /** How many files the session changed under this folder, at any depth. */
      readonly changed: number;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly name: string;
      /** How the session changed it, or null for a file of the repository it left alone. */
      readonly change: FileChange | null;
    };

type TreeFile = { readonly path: string; readonly change: FileChange | null };
type MutableFolder = { folders: Map<string, MutableFolder>; files: TreeFile[]; path: string };

/**
 * The repository as a tree, folders first and sorted by name, with changes
 * marked and deleted files kept. Without the bridge's listing, only changed
 * files. `filter` is a case-insensitive path substring.
 */
export function buildFileTree(
  files: readonly FileChange[],
  filter = "",
  allPaths: readonly string[] = [],
): readonly TreeNode[] {
  const needle = filter.trim().toLowerCase();
  const root: MutableFolder = { folders: new Map(), files: [], path: "" };
  const changes = new Map(files.map((file) => [file.path, file]));
  const entries: TreeFile[] = [];
  const seen = new Set<string>();
  for (const path of allPaths) {
    if (!seen.has(path)) {
      seen.add(path);
      entries.push({ path, change: changes.get(path) ?? null });
    }
  }
  for (const file of files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      entries.push({ path: file.path, change: file });
    }
  }
  for (const file of entries) {
    if (needle.length > 0 && !file.path.toLowerCase().includes(needle)) {
      continue;
    }
    const parts = file.path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      const path = `${folder.path}${part}/`;
      let next = folder.folders.get(part);
      if (next === undefined) {
        next = { folders: new Map(), files: [], path };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  const changedUnder = (nodes: readonly TreeNode[]): number =>
    nodes.reduce(
      (sum, node) => sum + (node.kind === "folder" ? node.changed : node.change === null ? 0 : 1),
      0,
    );
  const toNodes = (folder: MutableFolder): TreeNode[] => [
    ...[...folder.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]): TreeNode => {
        const children = toNodes(child);
        return {
          kind: "folder",
          path: child.path,
          name,
          children,
          changed: changedUnder(children),
        };
      }),
    ...[...folder.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(
        (file): TreeNode => ({
          kind: "file",
          path: file.path,
          name: splitPath(file.path).name,
          change: file.change,
        }),
      ),
  ];
  return toNodes(root);
}

/** The one-letter change marker and the word a screen reader hears for it. */
export const CHANGE_MARK: Record<FileChange["status"], { letter: string; word: string }> = {
  added: { letter: "A", word: "added" },
  modified: { letter: "M", word: "modified" },
  deleted: { letter: "D", word: "deleted" },
  renamed: { letter: "R", word: "renamed" },
};

/** A folder's marker in words: "contains 1 changed file", "contains 3 changed files". */
export function changedFilesWords(count: number): string {
  return count === 1 ? "contains 1 changed file" : `contains ${count} changed files`;
}

/**
 * Every path the session changed in any turn. A path outside this set is the
 * base commit's file, which the file view reads from GitHub (record 13).
 */
export function pathsChangedInSession(view: SessionView): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of view.git.sessionDiff?.files ?? []) {
    paths.add(file.path);
  }
  for (const diff of view.git.turnDiffs.values()) {
    for (const file of diff.files) {
      paths.add(file.path);
    }
  }
  return paths;
}

/**
 * What the diff area shows for the tree's selection: its section in this diff,
 * the base commit's copy for an unchanged file, or only a note for a file an
 * earlier turn changed (its content is no longer the base's) or with no session.
 */
export type SelectionShown =
  | { readonly kind: "in_diff" }
  | { readonly kind: "base_file"; readonly path: string }
  | { readonly kind: "note"; readonly path: string; readonly changedEarlier: boolean };

export function selectionShown(
  changedInSession: ReadonlySet<string>,
  diff: DiffView,
  selected: string | null,
  canRead: boolean,
): SelectionShown {
  if (selected === null || diff.files.some((file) => file.path === selected)) {
    return { kind: "in_diff" };
  }
  const changedEarlier = changedInSession.has(selected);
  return canRead && !changedEarlier
    ? { kind: "base_file", path: selected }
    : { kind: "note", path: selected, changedEarlier };
}

/** "1 file" or "3 files". */
export function filesWord(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}
