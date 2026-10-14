import { defineConfig } from "vitest/config";

const oneHundredPercentBranches = {
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
      exclude: ["src/**/*.test.ts", "src/testing/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "src/redact*": oneHundredPercentBranches,
      },
    },
  },
});
