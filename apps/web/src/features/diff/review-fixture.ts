/**
 * A session with two runs that changed files and ran checks, for the diff unit
 * tests and the dev harness (`/dev/session?fixture=review`). Dev and test only.
 */
import type { CommittedEvent } from "@oncue/protocol";
import { makeCommittedEvent, testArtifactRef, testFileChange } from "@oncue/protocol/testing";

export const FIRST_RUN = "run_1";
export const SECOND_RUN = "run_2";

/** Five files, so the card shows three and offers "Show 2 more files". */
export const FIRST_TURN_PATCH = [
  "diff --git a/app/page.tsx b/app/page.tsx",
  "index 1111111..2222222 100644",
  "--- a/app/page.tsx",
  "+++ b/app/page.tsx",
  "@@ -4,6 +4,8 @@ import { retry } from '../lib/retry';",
  " export default function Page() {",
  "   const budget = 3;",
  "-  const attempts = 1;",
  "+  const attempts = retry(budget);",
  "+  // Each attempt waits twice as long as the one before.",
  "+  const backoff = 2;",
  "   return (",
  "     <main>",
  "@@ -40,3 +42,3 @@ export default function Page() {",
  "       <footer>",
  "-        <p>Done</p>",
  "+        <p>Done after {attempts} attempts</p>",
  "       </footer>",
  "diff --git a/lib/retry.ts b/lib/retry.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/lib/retry.ts",
  "@@ -0,0 +1,4 @@",
  "+export function retry(budget: number): number {",
  "+  if (budget < 1) throw new Error('<img src=x onerror=alert(1)>');",
  "+  return budget;",
  "+}",
  "diff --git a/lib/old.ts b/lib/old.ts",
  "deleted file mode 100644",
  "--- a/lib/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const old = 1;",
  "-export const older = 2;",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -10,2 +10,3 @@",
  " ## Testing",
  "+Run `node --test` to run the tests.",
  " ",
  "diff --git a/package.json b/package.json",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -2 +2 @@",
  '-  "version": "1.0.0",',
  '+  "version": "1.1.0",',
  "",
].join("\n");

export const FIRST_TURN_FILES = [
  testFileChange({ path: "app/page.tsx", status: "modified", additions: 4, deletions: 2 }),
  testFileChange({ path: "lib/retry.ts", status: "added", additions: 4, deletions: 0 }),
  testFileChange({ path: "lib/old.ts", status: "deleted", additions: 0, deletions: 2 }),
  testFileChange({ path: "README.md", status: "modified", additions: 1, deletions: 0 }),
  testFileChange({ path: "package.json", status: "modified", additions: 1, deletions: 1 }),
];

const SECOND_TURN_PATCH = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -11 +11,2 @@",
  " Run `node --test` to run the tests.",
  "+Run `node --run lint` to lint.",
  "",
].join("\n");

const SECOND_TURN_FILES = [
  testFileChange({ path: "README.md", status: "modified", additions: 1, deletions: 0 }),
];

type Options = {
  /** The session diff arrives as an uploaded artifact instead of inline. */
  readonly sessionDiffAsArtifact?: boolean;
  /** The session diff names a tree listing artifact (record 13). */
  readonly sessionTree?: boolean;
};

/** The artifact the fixture's session diff names when `sessionTree` is set. */
export const SESSION_TREE_ARTIFACT_ID = "art_session_tree";

export function reviewFixtureEvents(options: Options = {}): CommittedEvent[] {
  let sequence = 0;
  const next = () => {
    sequence += 1;
    return { sessionSequence: sequence };
  };
  let eventCount = 0;
  const eventId = () => {
    eventCount += 1;
    return `evt_review_${eventCount}`;
  };

  const checks = (
    runId: string,
    specs: readonly {
      checkId: string;
      name: string;
      category: string;
      classification: "required" | "recommended" | "informational";
      attempts: readonly {
        result: "passed" | "failed" | "skipped" | "inconclusive";
        durationMs: number;
        summary: string;
        artifactId: string | null;
        baseComparison?: "not_compared" | "new_failure" | "reproduced_on_base" | "not_comparable";
        skipReason?: "user_requested" | null;
      }[];
    }[],
  ): CommittedEvent[] =>
    specs.flatMap((spec) =>
      spec.attempts.flatMap((attempt, index) => {
        const evidence =
          attempt.artifactId === null
            ? []
            : [testArtifactRef({ artifactId: attempt.artifactId, label: `${spec.name}.log` })];
        return [
          makeCommittedEvent(
            "verification.started",
            {
              eventId: eventId(),
              runId,
              payload: {
                checkId: spec.checkId,
                name: spec.name,
                category: spec.category,
                classification: spec.classification,
                method: { kind: "command", command: `npm run ${spec.name}`, cwd: null },
                attempt: index + 1,
                reason: `package.json script ${spec.name}`,
              },
            },
            next(),
          ),
          ...evidence.map((artifact) =>
            makeCommittedEvent(
              "artifact.created",
              { eventId: eventId(), runId, payload: { artifact, producer: "verification" } },
              next(),
            ),
          ),
          makeCommittedEvent(
            "verification.result",
            {
              eventId: eventId(),
              runId,
              payload: {
                checkId: spec.checkId,
                attempt: index + 1,
                result: attempt.result,
                skipReason: attempt.skipReason ?? null,
                exitCode: attempt.result === "passed" ? 0 : attempt.result === "failed" ? 1 : null,
                durationMs: attempt.durationMs,
                summary: attempt.summary,
                baseComparison: attempt.baseComparison ?? "not_compared",
                evidence,
              },
            },
            next(),
          ),
        ];
      }),
    );

  return [
    makeCommittedEvent("run.queued", { eventId: eventId(), runId: FIRST_RUN }, next()),
    makeCommittedEvent("run.started", { eventId: eventId(), runId: FIRST_RUN }, next()),
    makeCommittedEvent(
      "message.completed",
      {
        eventId: eventId(),
        runId: FIRST_RUN,
        payload: {
          messageId: "msg_review_1",
          parts: [{ type: "text", text: "Added a retry budget to the page and a helper for it." }],
        },
      },
      next(),
    ),
    makeCommittedEvent(
      "diff.updated",
      {
        eventId: eventId(),
        runId: FIRST_RUN,
        payload: {
          scope: "turn",
          files: FIRST_TURN_FILES,
          additions: 10,
          deletions: 5,
          body: { kind: "inline", patch: FIRST_TURN_PATCH },
          truncated: false,
        },
      },
      next(),
    ),
    ...checks(FIRST_RUN, [
      {
        checkId: "chk_test_1",
        name: "test",
        category: "test",
        classification: "required",
        attempts: [
          {
            result: "failed",
            durationMs: 2100,
            summary: "not ok 1 - retry\n# <b>fail</b> 1",
            artifactId: "art_test_1a",
          },
          {
            result: "passed",
            durationMs: 1900,
            summary: "ok 1 - retry <script>alert(1)</script>\n# pass 1",
            artifactId: "art_test_1b",
          },
        ],
      },
      {
        checkId: "chk_typecheck_1",
        name: "typecheck",
        category: "typecheck",
        classification: "required",
        attempts: [{ result: "passed", durationMs: 800, summary: "", artifactId: "art_tc_1" }],
      },
      {
        checkId: "chk_lint_1",
        name: "lint",
        category: "lint",
        classification: "recommended",
        attempts: [
          {
            result: "failed",
            durationMs: 450,
            summary: "1 problem",
            artifactId: "art_missing",
            baseComparison: "reproduced_on_base",
          },
        ],
      },
    ]),
    makeCommittedEvent("run.verified", { eventId: eventId(), runId: FIRST_RUN }, next()),

    makeCommittedEvent(
      "run.queued",
      {
        eventId: eventId(),
        runId: SECOND_RUN,
        payload: {
          commandId: "cmd_review_2",
          instruction: { messageId: "msg_user_2", text: "Document lint too.", attachments: [] },
          trigger: "follow_up",
          continuesRunId: FIRST_RUN,
        },
      },
      next(),
    ),
    makeCommittedEvent("run.started", { eventId: eventId(), runId: SECOND_RUN }, next()),
    makeCommittedEvent(
      "diff.updated",
      {
        eventId: eventId(),
        runId: SECOND_RUN,
        payload: {
          scope: "turn",
          files: SECOND_TURN_FILES,
          additions: 1,
          deletions: 0,
          body: { kind: "inline", patch: SECOND_TURN_PATCH },
          truncated: false,
        },
      },
      next(),
    ),
    makeCommittedEvent(
      "diff.updated",
      {
        eventId: eventId(),
        runId: SECOND_RUN,
        payload: {
          scope: "session",
          files: FIRST_TURN_FILES.map((file) =>
            file.path === "README.md" ? { ...file, additions: 2 } : file,
          ),
          additions: 11,
          deletions: 5,
          body:
            options.sessionDiffAsArtifact === true
              ? {
                  kind: "artifact",
                  artifact: testArtifactRef({
                    artifactId: "art_session_diff",
                    kind: "diff",
                    contentType: "text/x-diff",
                    label: "session.diff",
                  }),
                }
              : { kind: "inline", patch: `${FIRST_TURN_PATCH}${SECOND_TURN_PATCH}` },
          truncated: options.sessionDiffAsArtifact === true,
          ...(options.sessionTree === true
            ? {
                tree: testArtifactRef({
                  artifactId: SESSION_TREE_ARTIFACT_ID,
                  kind: "file",
                  contentType: "text/plain; charset=utf-8",
                  label: "tree.txt",
                }),
              }
            : {}),
        },
      },
      next(),
    ),
    ...checks(SECOND_RUN, [
      {
        checkId: "chk_test_2",
        name: "test",
        category: "test",
        classification: "required",
        attempts: [{ result: "passed", durationMs: 1700, summary: "ok", artifactId: null }],
      },
      {
        checkId: "chk_typecheck_2",
        name: "typecheck",
        category: "typecheck",
        classification: "required",
        attempts: [
          {
            result: "skipped",
            durationMs: 0,
            summary: "Skipped at the user's request.",
            artifactId: null,
            skipReason: "user_requested",
          },
        ],
      },
    ]),
    makeCommittedEvent(
      "run.completed_with_warnings",
      {
        eventId: eventId(),
        runId: SECOND_RUN,
        payload: {
          warnings: [
            {
              text: "typecheck was skipped at your request.",
              recommendedAction: "Run it before merging.",
            },
          ],
        },
      },
      next(),
    ),
  ];
}

/**
 * One run whose diffs are `lineCount` added lines over ten new files, for the
 * perf test. Lines are short so 3,000 of them fit the inline text limit.
 */
export function largeReviewFixtureEvents(lineCount: number): CommittedEvent[] {
  const fileCount = 10;
  const perFile = Math.ceil(lineCount / fileCount);
  const files: ReturnType<typeof testFileChange>[] = [];
  const patch: string[] = [];
  let remaining = lineCount;
  for (let index = 0; index < fileCount && remaining > 0; index += 1) {
    const count = Math.min(perFile, remaining);
    remaining -= count;
    const path = `src/generated/part-${index}.ts`;
    files.push(testFileChange({ path, status: "added", additions: count, deletions: 0 }));
    patch.push(
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${count} @@`,
    );
    for (let line = 1; line <= count; line += 1) {
      patch.push(`+v${line}`);
    }
  }
  let sequence = 0;
  const next = () => {
    sequence += 1;
    return { sessionSequence: sequence };
  };
  return [
    makeCommittedEvent("run.queued", { eventId: "evt_large_1", runId: FIRST_RUN }, next()),
    makeCommittedEvent("run.started", { eventId: "evt_large_2", runId: FIRST_RUN }, next()),
    // The same change for both scopes.
    ...(["turn", "session"] as const).map((scope, index) =>
      makeCommittedEvent(
        "diff.updated",
        {
          eventId: `evt_large_${3 + index}`,
          runId: FIRST_RUN,
          payload: {
            scope,
            files,
            additions: lineCount,
            deletions: 0,
            body: { kind: "inline", patch: `${patch.join("\n")}\n` },
            truncated: false,
          },
        },
        next(),
      ),
    ),
  ];
}
