import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const codeToHtml =
  vi.fn<(code: string, options: { lang: string; theme: string }) => Promise<string>>();

vi.mock("shiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("shiki")>();
  return {
    ...actual,
    codeToHtml: (code: string, options: { lang: string; theme: string }) =>
      codeToHtml(code, options),
  };
});

const { CodeBlock, codeLanguage } = await import("./code-block");

afterEach(() => {
  cleanup();
  codeToHtml.mockReset();
});

function deferred() {
  let resolve: (html: string) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("codeLanguage", () => {
  it("names a bundled grammar or alias, whatever its case", () => {
    expect(codeLanguage("typescript")).toBe("typescript");
    expect(codeLanguage("ts")).toBe("ts");
    expect(codeLanguage(" Python ")).toBe("python");
  });

  it("is null for a language shiki does not bundle", () => {
    expect(codeLanguage("not-a-language")).toBeNull();
    expect(codeLanguage("")).toBeNull();
    // Inherited object keys are not grammars.
    expect(codeLanguage("constructor")).toBeNull();
  });
});

describe("CodeBlock", () => {
  it("shows an unknown language as plain text and never asks shiki for it", () => {
    const { container } = render(<CodeBlock code="SELECT 1 FROM weird" language="mystery" />);

    expect(container.querySelector("pre code")?.textContent).toBe("SELECT 1 FROM weird");
    expect(codeToHtml).not.toHaveBeenCalled();
  });

  it("keeps the plain text when highlighting fails, with no unhandled rejection", async () => {
    codeToHtml.mockRejectedValue(new Error("grammar failed to load"));
    const { container } = render(<CodeBlock code="const x = 1;" language="ts" />);

    await act(async () => {});

    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
    expect(container.firstElementChild?.getAttribute("data-highlighted")).toBe("false");
  });

  it("shows plain text until the highlight arrives, then the highlight", async () => {
    codeToHtml.mockImplementation(
      async (code, options) => `<pre class="${options.theme}"><code>${code}</code></pre>`,
    );
    const { container } = render(<CodeBlock code="ok" language="ts" />);
    expect(container.querySelector("pre code")?.textContent).toBe("ok");

    await act(async () => {});

    expect(container.firstElementChild?.getAttribute("data-highlighted")).toBe("true");
    expect(container.querySelector("pre.one-light")).not.toBeNull();
    expect(container.querySelector("pre.one-dark-pro")).not.toBeNull();
  });

  it("drops a highlight of code that has since changed", async () => {
    const first = [deferred(), deferred()];
    const second = [deferred(), deferred()];
    const queue = [...first, ...second];
    codeToHtml.mockImplementation(() => (queue.shift() as ReturnType<typeof deferred>).promise);
    const view = render(<CodeBlock code="old" language="ts" />);
    view.rerender(<CodeBlock code="new" language="ts" />);

    await act(async () => {
      for (const pending of second) {
        pending.resolve("<pre><code>new highlighted</code></pre>");
      }
    });
    await act(async () => {
      for (const pending of first) {
        pending.resolve("<pre><code>old highlighted</code></pre>");
      }
    });

    expect(view.container.textContent).toContain("new highlighted");
    expect(view.container.textContent).not.toContain("old");
  });

  it("sets nothing after it unmounts", async () => {
    const pending = [deferred(), deferred()];
    const queue = [...pending];
    codeToHtml.mockImplementation(() => (queue.shift() as ReturnType<typeof deferred>).promise);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<CodeBlock code="x" language="ts" />);
    view.unmount();

    await act(async () => {
      for (const entry of pending) {
        entry.resolve("<pre></pre>");
      }
    });

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
