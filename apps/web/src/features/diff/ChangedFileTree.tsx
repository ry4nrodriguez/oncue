/**
 * The review panel's file tree (record 13), with changed files marked and the
 * rest dimmed. The folder row is written here rather than using the vendored
 * `FileTreeFolder`, which nests two buttons in a focusable tree item and fails
 * axe's nested-interactive rule; here a folder is one keyboard-operable item.
 */
import type { FileChange } from "@oncue/protocol";
import { ChevronRight, FileIcon, Folder, FolderOpen } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useMemo, useState } from "react";
import {
  FileTree,
  FileTreeFile,
  FileTreeIcon,
  FileTreeName,
} from "@/components/ai-elements/file-tree";
import { cn } from "@/lib/utils";
import { buildFileTree, CHANGE_MARK, changedFilesWords, type TreeNode } from "./review-model";

const MARK_CLASS: Record<FileChange["status"], string> = {
  added: "text-positive",
  modified: "text-caution",
  deleted: "text-danger",
  renamed: "text-accent-text",
};

function FolderItem({
  node,
  open,
  depth,
  onToggle,
  children,
}: {
  node: Extract<TreeNode, { kind: "folder" }>;
  open: boolean;
  depth: number;
  onToggle: (path: string, open: boolean) => void;
  children: ReactNode;
}) {
  // A click or key inside a nested item bubbles here; only this item's own row
  // toggles it.
  const own = (event: MouseEvent | KeyboardEvent) =>
    (event.target as Element).closest("[role=treeitem]") === event.currentTarget;

  return (
    <div
      role="treeitem"
      aria-expanded={open}
      aria-level={depth}
      tabIndex={0}
      data-tree-path={node.path}
      className="rounded outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onClick={(event) => {
        if (own(event)) {
          onToggle(node.path, !open);
        }
      }}
      onKeyDown={(event) => {
        if (!own(event)) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle(node.path, !open);
        } else if (event.key === "ArrowRight" && !open) {
          event.preventDefault();
          onToggle(node.path, true);
        } else if (event.key === "ArrowLeft" && open) {
          event.preventDefault();
          onToggle(node.path, false);
        }
      }}
    >
      <div className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-[3px] hover:bg-hover">
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-faint transition-transform",
            open ? "rotate-90" : "",
          )}
          aria-hidden="true"
        />
        <FileTreeIcon>
          {open ? (
            <FolderOpen className="size-3.5 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Folder className="size-3.5 text-muted-foreground" aria-hidden="true" />
          )}
        </FileTreeIcon>
        <FileTreeName className="text-muted-foreground">{node.name}</FileTreeName>
        {node.changed === 0 ? null : (
          <>
            {/* Shows a closed folder holds changed files. */}
            <span
              className="ml-auto flex items-center gap-1 pl-2 font-mono text-[10px] text-positive"
              aria-hidden="true"
              data-testid="tree-folder-mark"
            >
              <span className="size-1.5 rounded-full bg-positive" />
              {node.changed}
            </span>
            <span className="sr-only">, {changedFilesWords(node.changed)}</span>
          </>
        )}
      </div>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: role=group is the tree pattern's child list, not a form group
        <div role="group" className="ml-3 border-border-soft border-l pl-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** `set` with `values` added (`member` true) or removed, or `set` itself when nothing changes. */
function withMembers(
  set: ReadonlySet<string>,
  values: readonly string[],
  member: boolean,
): ReadonlySet<string> {
  if (values.every((value) => set.has(value) === member)) {
    return set;
  }
  const next = new Set(set);
  for (const value of values) {
    if (member) {
      next.add(value);
    } else {
      next.delete(value);
    }
  }
  return next;
}

/** `a/b/c.ts` to `["a/", "a/b/"]`: the folder paths the tree names it under. */
export function ancestorFolders(path: string): readonly string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
}

/** Up, Down, Home, and End between the tree items a person can see. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) {
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=treeitem]")];
  const current = items.indexOf(
    (event.target as Element).closest("[role=treeitem]") as HTMLElement,
  );
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : current + (event.key === "ArrowDown" ? 1 : -1);
  const next = items[index];
  if (next !== undefined) {
    event.preventDefault();
    next.focus();
  }
}

export function ChangedFileTree({
  files,
  allPaths = [],
  selectedPath,
  onSelect,
}: {
  files: readonly FileChange[];
  /** Every path in the repository at the diff's head, when the bridge listed it. */
  allPaths?: readonly string[] | undefined;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  // Folders start closed so a whole repository does not bury the changed files.
  // This holds the folders opened, or while filtering (when matches show open)
  // the folders closed.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closedWhileFiltering, setClosedWhileFiltering] = useState<ReadonlySet<string>>(new Set());
  const filtering = filter.trim().length > 0;
  const nodes = useMemo(() => buildFileTree(files, filter, allPaths), [files, filter, allPaths]);

  // A newly selected file (a change card's row, say) opens the folders it sits in.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (selectedPath !== openedFor) {
    setOpenedFor(selectedPath);
    if (selectedPath !== null) {
      setOpened((current) => withMembers(current, ancestorFolders(selectedPath), true));
    }
  }

  const isOpen = (path: string) => (filtering ? !closedWhileFiltering.has(path) : opened.has(path));

  const toggle = (path: string, open: boolean) => {
    if (filtering) {
      setClosedWhileFiltering((current) => withMembers(current, [path], !open));
    } else {
      setOpened((current) => withMembers(current, [path], open));
    }
  };

  const render = (list: readonly TreeNode[], depth: number): ReactNode =>
    list.map((node) =>
      node.kind === "folder" ? (
        <FolderItem
          key={node.path}
          node={node}
          depth={depth}
          open={isOpen(node.path)}
          onToggle={toggle}
        >
          {render(node.children, depth + 1)}
        </FolderItem>
      ) : (
        <FileTreeFile
          key={node.path}
          path={node.path}
          name={node.name}
          aria-level={depth}
          aria-selected={selectedPath === node.path}
          data-tree-path={node.path}
          className={cn(
            "gap-1 px-1.5 py-[3px] outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-accent",
            selectedPath === node.path ? "bg-hover" : "",
          )}
        >
          <span className="size-3.5 shrink-0" />
          <FileTreeIcon>
            <FileIcon className="size-3.5 text-faint" aria-hidden="true" />
          </FileTreeIcon>
          <FileTreeName className={node.change === null ? "text-muted-foreground" : "text-text"}>
            {node.name}
          </FileTreeName>
          {node.change === null ? null : (
            <>
              <span
                className={cn("ml-auto pl-2 font-mono text-[10px]", MARK_CLASS[node.change.status])}
                aria-hidden="true"
                data-testid="tree-change-mark"
              >
                {CHANGE_MARK[node.change.status].letter}
              </span>
              <span className="sr-only">, {CHANGE_MARK[node.change.status].word}</span>
            </>
          )}
        </FileTreeFile>
      ),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 p-2">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files..."
          aria-label="Filter files"
          className="h-7 w-full rounded-md border border-border bg-canvas px-2 text-[12px] text-text outline-none placeholder:text-faint focus-visible:border-accent"
        />
      </div>
      <div className="scroll-pill min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {nodes.length === 0 ? (
          <p className="px-2 py-1 text-[12px] text-faint">No files match.</p>
        ) : (
          <FileTree
            aria-label="Changed files"
            selectedPath={selectedPath ?? undefined}
            onSelect={onSelect}
            onKeyDown={moveFocus}
            className="rounded-none border-0 bg-transparent font-sans text-[12px] [&>div]:p-0"
          >
            {render(nodes, 1)}
          </FileTree>
        )}
      </div>
    </div>
  );
}
