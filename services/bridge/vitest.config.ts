import { defineConfig } from "vitest/config";

const oneHundredPercent = {
  branches: 100,
  functions: 100,
  lines: 100,
  statements: 100,
};

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        // Record 23 puts secret redaction and credential handling at complete
        // branch coverage. These files run inside the sandbox and hold, write,
        // or scrub development secrets and the supervisor's privileged verbs.
        "src/redaction.ts": oneHundredPercent,
        "src/secrets.ts": oneHundredPercent,
        "src/secret-names.ts": oneHundredPercent,
        "src/supervisor-protocol.ts": oneHundredPercent,
        "src/checkpoint.ts": oneHundredPercent,
        // Which conversation an event belongs to, and the subagent limit, are
        // state-transition logic that decides what reaches the primary turn.
        "src/subagents.ts": oneHundredPercent,
        // The harness's permission asks: what is forwarded, and how it is answered.
        "src/permissions.ts": oneHundredPercent,
        "src/ask-category.ts": oneHundredPercent,
        // The question a harness waits on: one at a time, ended with its run.
        "src/questions.ts": oneHundredPercent,
      },
    },
  },
});
