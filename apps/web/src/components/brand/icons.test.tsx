import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicMark,
  ClaudeMark,
  GitHubMark,
  ModalMark,
  OpenAIMark,
  OpenCodeMark,
  PiMark,
} from "./icons";

afterEach(cleanup);

// SVG ids are document-global, so two `ModalMark`s must not share gradient ids.
describe("brand marks", () => {
  it("gives each Modal mark its own gradient ids and wires every reference to them", () => {
    const { container } = render(
      <div>
        <ModalMark className="h-4" />
        <ModalMark className="h-4" />
      </div>,
    );

    const ids = [...container.querySelectorAll("[id]")].map((node) => node.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(ids.length);

    const marks = [...container.querySelectorAll("svg")];
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      const defined = new Set([...mark.querySelectorAll("linearGradient")].map((node) => node.id));
      const referenced = [...mark.querySelectorAll("path")]
        .map((node) => node.getAttribute("fill") ?? "")
        .filter((fill) => fill.startsWith("url("))
        .map((fill) => fill.slice("url(#".length, -1));

      expect(defined.size).toBe(4);
      expect(referenced).toHaveLength(4);
      // Every reference resolves inside its own instance.
      for (const reference of referenced) {
        expect(defined.has(reference)).toBe(true);
      }
    }
  });

  it("keeps the Modal greens and leaves the one-colour marks inheriting", () => {
    const { container } = render(
      <div>
        <ModalMark className="h-4" />
        <GitHubMark className="h-4" />
        <AnthropicMark className="h-4" />
        <ClaudeMark className="h-4" />
        <OpenAIMark className="h-4" />
        <PiMark className="h-4" />
      </div>,
    );

    const [modal, ...oneColour] = [...container.querySelectorAll("svg")];
    expect(modal?.querySelector('path[fill="#62DE61"]')).toBeTruthy();
    for (const mark of oneColour) {
      expect(mark.getAttribute("fill")).toBe("currentColor");
    }
  });

  it("draws OpenCode's two variants, one per theme, in their own fills, and defines no id", () => {
    const { container } = render(<OpenCodeMark className="h-4" />);
    const [light, dark] = [...container.querySelectorAll("svg")];
    expect(light?.getAttribute("class")).toBe("h-4 oncue-mark-light");
    expect(dark?.getAttribute("class")).toBe("h-4 oncue-mark-dark");
    expect(light?.querySelector('path[fill="#211E1E"]')).toBeTruthy();
    expect(dark?.querySelector('path[fill="#F1ECEC"]')).toBeTruthy();
    expect(container.querySelectorAll("[id]")).toHaveLength(0);
    cleanup();
    const bare = render(<OpenCodeMark />);
    expect(bare.container.querySelector("svg")?.getAttribute("class")).toBe("oncue-mark-light");
  });
});
