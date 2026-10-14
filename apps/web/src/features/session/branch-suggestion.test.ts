import { foldEvents } from "@oncue/protocol";
import { makeCommittedEvent } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { suggestBranch } from "./branch-suggestion";

const answered = makeCommittedEvent(
  "message.completed",
  {
    runId: "run_1",
    payload: {
      messageId: "msg_a",
      role: "assistant",
      parts: [{ type: "text", text: "## Added a health endpoint\n\nIt answers 200." }],
    },
  },
  { sessionSequence: 1 },
);

describe("suggestBranch", () => {
  it("slugs the first line of the agent's latest words, with the suffix", () => {
    const view = foldEvents([answered]);
    expect(suggestBranch(view.git.description, view.messages, "7f3a")).toBe(
      "oncue/added-a-health-endpoint-7f3a",
    );
  });

  it("takes the agent's own branch name first, unsuffixed", () => {
    const view = foldEvents([
      answered,
      makeCommittedEvent(
        "pull_request.described",
        {
          runId: "run_1",
          payload: { title: null, body: null, branchName: "oncue/health-endpoint" },
        },
        { sessionSequence: 2 },
      ),
    ]);
    expect(suggestBranch(view.git.description, view.messages, "7f3a")).toBe(
      "oncue/health-endpoint",
    );
  });

  it("never takes a subagent's words for the agent's", () => {
    const view = foldEvents([
      answered,
      makeCommittedEvent(
        "message.completed",
        {
          runId: "run_1",
          payload: {
            messageId: "msg_child",
            role: "assistant",
            parts: [{ type: "text", text: "Found the retry budget" }],
            agentId: "ses_child",
          },
        },
        { sessionSequence: 2 },
      ),
    ]);
    expect(suggestBranch(view.git.description, view.messages, "7f3a")).toBe(
      "oncue/added-a-health-endpoint-7f3a",
    );
  });

  it("falls back to the plain slug with no words at all", () => {
    const view = foldEvents([]);
    expect(suggestBranch(view.git.description, view.messages, "7f3a")).toBe("oncue/task-7f3a");
  });
});
