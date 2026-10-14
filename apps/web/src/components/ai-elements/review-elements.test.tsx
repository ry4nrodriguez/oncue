import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Commit,
  CommitContent,
  CommitFile,
  CommitFileChanges,
  CommitFileInfo,
  CommitFilePath,
  CommitFiles,
} from "./commit";
import { FileTree, FileTreeFile, FileTreeFolder, FileTreeIcon, FileTreeName } from "./file-tree";

// Smoke coverage for the vendored AI Elements Commit and File Tree source,
// which record 24 treats as maintained source.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("vendored Commit", () => {
  it("renders its files", () => {
    render(
      <Commit defaultOpen>
        <CommitContent>
          <CommitFiles>
            <CommitFile>
              <CommitFileInfo>
                <CommitFilePath>src/retry.ts</CommitFilePath>
              </CommitFileInfo>
              <CommitFileChanges>+3 -1</CommitFileChanges>
            </CommitFile>
          </CommitFiles>
        </CommitContent>
      </Commit>,
    );
    expect(screen.getByText("src/retry.ts")).toBeTruthy();
    expect(screen.getByText("+3 -1")).toBeTruthy();
  });
});

describe("vendored File Tree", () => {
  it("expands a folder and selects files", () => {
    const onSelect = vi.fn();
    const onExpandedChange = vi.fn();
    render(
      <FileTree onSelect={onSelect} onExpandedChange={onExpandedChange} selectedPath="src/a.ts">
        <FileTreeFolder path="src" name="src">
          <FileTreeFile path="src/a.ts" name="a.ts" />
          <FileTreeFile path="src/b.ts" name="b.ts">
            <FileTreeIcon>*</FileTreeIcon>
            <FileTreeName>b.ts</FileTreeName>
          </FileTreeFile>
        </FileTreeFolder>
      </FileTree>,
    );
    const [toggle, folder] = screen.getAllByRole("button") as HTMLElement[];
    fireEvent.click(toggle as HTMLElement);
    expect(onExpandedChange).toHaveBeenCalled();
    fireEvent.click(folder as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("src");
    const file = screen.getByText("a.ts").closest("[role=treeitem]") as HTMLElement;
    fireEvent.click(file);
    fireEvent.keyDown(file, { key: "Enter" });
    fireEvent.keyDown(file, { key: "x" });
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
    fireEvent.click(toggle as HTMLElement);
  });
});
