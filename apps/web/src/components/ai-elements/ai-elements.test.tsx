import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { CodeBlock } from "./code-block";
import { Conversation, ConversationContent } from "./conversation";
import { Message, MessageContent, MessageResponse } from "./message";

// Smoke coverage for the vendored AI Elements source, which record 24 treats as maintained source.
describe("ai elements", () => {
  beforeAll(() => {
    // `conversation` uses use-stick-to-bottom, which needs ResizeObserver; jsdom lacks it.
    if (!("ResizeObserver" in globalThis)) {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });

  it("renders a conversation with its content", () => {
    render(
      <Conversation>
        <ConversationContent>
          <p>No messages</p>
        </ConversationContent>
      </Conversation>,
    );
    expect(screen.getByText("No messages")).toBeTruthy();
  });

  it("renders a message", () => {
    render(
      <Message from="assistant">
        <MessageContent>Backoff is in.</MessageContent>
      </Message>,
    );
    expect(screen.getByText("Backoff is in.")).toBeTruthy();
  });

  it("renders a code block", async () => {
    // shiki highlights asynchronously, so the first paint is empty.
    const { container } = render(<CodeBlock code="const budget = 5;" language="ts" />);
    await waitFor(() => expect(container.textContent).toContain("const budget = 5;"));
  });

  it("renders a user message's markdown response", () => {
    render(
      <Message from="user">
        <MessageContent>
          <MessageResponse>Add a retry budget.</MessageResponse>
        </MessageContent>
      </Message>,
    );
    expect(screen.getByText("Add a retry budget.")).toBeTruthy();
  });

  it("renders code block children beside the highlighted code", async () => {
    const { container } = render(
      <CodeBlock code="ok" language="ts">
        <span>Copy</span>
      </CodeBlock>,
    );
    expect(screen.getByText("Copy")).toBeTruthy();
    await waitFor(() => expect(container.textContent).toContain("ok"));
  });
});
