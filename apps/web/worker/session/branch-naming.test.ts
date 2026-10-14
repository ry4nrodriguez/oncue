import { describe, expect, it } from "vitest";
import {
  baseBranchOf,
  chooseBranchName,
  cloneBranch,
  grantTaskBranch,
  summaryFirstLine,
} from "./branch-naming";

describe("branch naming (record 07)", () => {
  it("reads the grant's task branch, and takes the branch itself from a row written before lazy naming", () => {
    expect(grantTaskBranch({ branch: "main", taskBranch: null })).toBeNull();
    expect(grantTaskBranch({ branch: "oncue/x-1a2b", taskBranch: "oncue/x-1a2b" })).toBe(
      "oncue/x-1a2b",
    );
    expect(grantTaskBranch({ branch: "oncue/old-0000" })).toBe("oncue/old-0000");
  });

  it("clones the task branch once named and the base branch before", () => {
    expect(cloneBranch(null, "main")).toBe("main");
    expect(cloneBranch("oncue/x-1a2b", "main")).toBe("oncue/x-1a2b");
    expect(baseBranchOf({ base_branch: "develop" })).toBe("develop");
    expect(baseBranchOf(undefined)).toBe("");
  });

  it("takes the first non-blank line of the latest ending's account, without its marks", () => {
    const envelope = (whatChanged: string) =>
      JSON.stringify({ type: "run.verified", payload: { summary: { whatChanged } } });
    expect(summaryFirstLine(undefined)).toBeNull();
    expect(
      summaryFirstLine({ envelope_json: envelope("\n- Added the health endpoint\n- More") }),
    ).toBe("Added the health endpoint");
    expect(summaryFirstLine({ envelope_json: envelope("## Summary") })).toBe("Summary");
    expect(summaryFirstLine({ envelope_json: envelope("  \n\t\n") })).toBeNull();
  });

  it("uses the requested name when git would take it, else a slug of the summary, the title, or 'task'", () => {
    expect(
      chooseBranchName({ requested_name: "oncue/health-endpoint" }, null, "x", "y", "1a2b"),
    ).toBe("oncue/health-endpoint");
    expect(
      chooseBranchName({ requested_name: "oncue/bad name!" }, null, "Added a thing", "y", "1a2b"),
    ).toBe("oncue/added-a-thing-1a2b");
    expect(
      chooseBranchName({ requested_name: null }, null, null, "Fix the login bug", "1a2b"),
    ).toBe("oncue/fix-the-login-bug-1a2b");
    expect(chooseBranchName(undefined, null, null, null, "1a2b")).toBe("oncue/task-1a2b");
  });

  it("takes the agent's name when nobody typed one, and a typed name over it", () => {
    expect(chooseBranchName(undefined, "oncue/fix-login", "Added a thing", "y", "1a2b")).toBe(
      "oncue/fix-login",
    );
    expect(
      chooseBranchName({ requested_name: null }, "oncue/fix-login", "Added a thing", "y", "1a2b"),
    ).toBe("oncue/fix-login");
    expect(
      chooseBranchName({ requested_name: "oncue/typed" }, "oncue/fix-login", "x", "y", "1a2b"),
    ).toBe("oncue/typed");
    expect(chooseBranchName(undefined, "oncue/.bad", "Added a thing", "y", "1a2b")).toBe(
      "oncue/added-a-thing-1a2b",
    );
  });

  it("refuses a requested name git would refuse: a component starting with a dot or ending in .lock", () => {
    for (const bad of ["oncue/.hidden", "oncue/a/.b", "oncue/a.lock/b", "oncue/a.lock"]) {
      expect(chooseBranchName({ requested_name: bad }, null, "Added a thing", "y", "1a2b")).toBe(
        "oncue/added-a-thing-1a2b",
      );
    }
    expect(chooseBranchName({ requested_name: "oncue/a.b/c-d" }, null, "x", "y", "1a2b")).toBe(
      "oncue/a.b/c-d",
    );
  });
});
