import { describe, expect, it } from "vitest";
import {
  type DetectedCommands,
  describeDefinition,
  detect,
  detectInstall,
  type ProjectFile,
  type RepositoryFiles,
  readProjectYaml,
  resolve,
} from "./repo-config";

function filesOf(contents: Readonly<Record<string, string>>): RepositoryFiles {
  return {
    readFile: (path) => (path in contents ? (contents[path] ?? null) : null),
    exists: (path) => path in contents,
  };
}

const NO_COMMANDS: DetectedCommands = {
  test: null,
  lint: null,
  typecheck: null,
  build: null,
  dev: null,
};

describe("detect", () => {
  it("proposes nothing when package.json is absent", () => {
    expect(detect(filesOf({}))).toEqual(NO_COMMANDS);
  });

  it("proposes nothing when package.json does not parse", () => {
    expect(detect(filesOf({ "package.json": "{ not json" }))).toEqual(NO_COMMANDS);
  });

  it("proposes nothing when package.json has no scripts object", () => {
    expect(detect(filesOf({ "package.json": JSON.stringify({ name: "widgets" }) }))).toEqual(
      NO_COMMANDS,
    );
  });

  it("proposes npm run <name> for each script present, defaulting to npm with no lockfile", () => {
    const files = filesOf({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    });
    expect(detect(files)).toEqual({
      test: "npm run test",
      lint: null,
      typecheck: null,
      build: "npm run build",
      dev: null,
    });
  });

  it("uses pnpm run <name> when pnpm-lock.yaml exists", () => {
    const files = filesOf({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", dev: "vite" } }),
      "pnpm-lock.yaml": "",
    });
    expect(detect(files)).toEqual({
      test: "pnpm run test",
      lint: null,
      typecheck: null,
      build: null,
      dev: "pnpm run dev",
    });
  });

  it("uses yarn run <name> when yarn.lock exists, and prefers pnpm over yarn when both are present", () => {
    const yarnOnly = filesOf({
      "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "yarn.lock": "",
    });
    expect(detect(yarnOnly).lint).toBe("yarn run lint");

    const both = filesOf({
      "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
      "yarn.lock": "",
      "pnpm-lock.yaml": "",
    });
    expect(both !== undefined);
    expect(detect(both).lint).toBe("pnpm run lint");
  });

  it("proposes every one of test/lint/typecheck/build/dev when all scripts are present", () => {
    const files = filesOf({
      "package.json": JSON.stringify({
        scripts: { test: "a", lint: "b", typecheck: "c", build: "d", dev: "e" },
      }),
      "package-lock.json": "",
    });
    expect(detect(files)).toEqual({
      test: "npm run test",
      lint: "npm run lint",
      typecheck: "npm run typecheck",
      build: "npm run build",
      dev: "npm run dev",
    });
  });
});

describe("readProjectYaml", () => {
  it("reads record 08's example subset", () => {
    const text = [
      "version: 1",
      "commands:",
      "  dev: npm run dev",
      "  test: npm test",
      "  lint: npm run lint",
      "  typecheck: npm run typecheck",
      "  build: npm run build",
      "preview:",
      "  port: 3000",
      "  health_path: /",
      "",
    ].join("\n");
    const result = readProjectYaml(text);
    expect(result.kind).toBe("ok");
    const file = (result as { kind: "ok"; file: ProjectFile }).file;
    expect(file).toEqual({
      version: 1,
      commands: {
        dev: "npm run dev",
        test: "npm test",
        lint: "npm run lint",
        typecheck: "npm run typecheck",
        build: "npm run build",
      },
      preview: { port: 3000, health_path: "/" },
    });
  });

  it("reads a file with only some keys present", () => {
    const result = readProjectYaml("commands:\n  test: npm test\n");
    expect(result).toEqual({ kind: "ok", file: { commands: { test: "npm test" } } });
  });

  it("reads an empty file as an empty definition", () => {
    expect(readProjectYaml("")).toEqual({ kind: "ok", file: {} });
    expect(readProjectYaml("\n\n# just a comment\n")).toEqual({ kind: "ok", file: {} });
  });

  it("accepts single- and double-quoted scalars", () => {
    const result = readProjectYaml("commands:\n  test: \"npm test\"\n  lint: 'npm run lint'\n");
    expect(result).toEqual({
      kind: "ok",
      file: { commands: { test: "npm test", lint: "npm run lint" } },
    });
  });

  it("rejects an unknown top-level key, naming the line", () => {
    const result = readProjectYaml("runtimes:\n  node: 22\n");
    expect(result.kind).toBe("error");
    const error = (result as { kind: "error"; error: { line: number; text: string } }).error;
    expect(error.line).toBe(1);
    expect(error.text).toBe("runtimes:");
  });

  it("rejects an unknown key under commands", () => {
    const result = readProjectYaml("commands:\n  install: npm ci\n");
    expect(result.kind).toBe("error");
    expect((result as { kind: "error"; error: { line: number } }).error.line).toBe(2);
  });

  it("rejects an unknown key under preview", () => {
    const result = readProjectYaml("preview:\n  path: /health\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a non-integer version", () => {
    const result = readProjectYaml("version: one\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a non-integer preview.port", () => {
    const result = readProjectYaml("preview:\n  port: many\n  health_path: /\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a non-string command value", () => {
    const result = readProjectYaml("commands:\n  test: 123\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a list item", () => {
    const result = readProjectYaml("commands:\n  - npm test\n");
    expect(result.kind).toBe("error");
  });

  it("rejects an anchor", () => {
    const result = readProjectYaml("commands: &defaults\n  test: npm test\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a nested map deeper than one level", () => {
    const result = readProjectYaml("commands:\n  test:\n    run: npm test\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a multi-document marker", () => {
    const result = readProjectYaml("---\nversion: 1\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a line with no colon at all", () => {
    const result = readProjectYaml("this is not yaml\n");
    expect(result.kind).toBe("error");
  });

  it("rejects indentation with no open section", () => {
    const result = readProjectYaml("  test: npm test\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a top-level key that is itself a scalar assignment for commands/preview", () => {
    const result = readProjectYaml("commands: npm test\n");
    expect(result.kind).toBe("error");
  });

  it("rejects a flow sequence value", () => {
    const result = readProjectYaml("commands:\n  test: [npm, test]\n");
    expect(result.kind).toBe("error");
  });
});

describe("readProjectYaml: secrets (record 08)", () => {
  function secretsOf(text: string) {
    const result = readProjectYaml(text);
    if (result.kind !== "ok") {
      throw new Error(`expected ok, got line ${result.error.line}: ${result.error.reason}`);
    }
    return result.file.secrets;
  }

  function reasonOf(text: string) {
    const result = readProjectYaml(text);
    return result.kind === "error" ? `${result.error.line}: ${result.error.reason}` : "ok";
  }

  it("reads record 08's shape: required and optional lists of names", () => {
    expect(
      secretsOf(
        [
          "version: 1",
          "secrets:",
          "  required:",
          "    - DATABASE_URL",
          "  optional:",
          "    - STRIPE_TEST_KEY",
          "    - SENTRY_DSN   # a trailing comment",
          "commands:",
          "  test: pnpm test",
        ].join("\n"),
      ),
    ).toEqual({ required: ["DATABASE_URL"], optional: ["STRIPE_TEST_KEY", "SENTRY_DSN"] });
  });

  it("reads one list without the other, and an empty section as no names", () => {
    expect(secretsOf("secrets:\n  optional:\n    - A_NAME")).toEqual({
      required: [],
      optional: ["A_NAME"],
    });
    expect(secretsOf("secrets:\n  required:\n")).toEqual({ required: [], optional: [] });
    expect(secretsOf("version: 1")).toBeUndefined();
  });

  it("still refuses a list anywhere else", () => {
    expect(reasonOf("commands:\n  - pnpm test")).toBe(
      "2: lists, anchors, and aliases are not supported",
    );
    expect(reasonOf("- DATABASE_URL")).toBe("1: lists, anchors, and aliases are not supported");
    expect(reasonOf("secrets:\n  - DATABASE_URL")).toBe(
      '2: a name must sit under "secrets.required" or "secrets.optional"',
    );
  });

  it.each([
    ["secrets: DATABASE_URL", '1: "secrets" must introduce a nested block, not a scalar'],
    [
      "secrets:\n  required: DATABASE_URL",
      '2: "secrets.required" must introduce a list, not a scalar',
    ],
    ["secrets:\n  sometimes:\n    - A_NAME", '2: unknown key "sometimes" under "secrets"'],
    ["secrets:\n  required:\n    - database_url", '3: "database_url" is not a secret name'],
    ["secrets:\n  required:\n    - A NAME", '3: "A NAME" is not a secret name'],
    ["secrets:\n  required:\n    - NODE_OPTIONS", '3: "NODE_OPTIONS" is reserved'],
    ["secrets:\n  required:\n    - GITHUB_TOKEN", '3: "GITHUB_TOKEN" is a platform credential'],
    ["secrets:\n  required:\n    -", "3: a list item needs a name"],
    ["secrets:\n  required:\n    - A_NAME: nested", '3: "A_NAME: nested" is not a secret name'],
    ["secrets:\n  required:\n    - A_NAME\n    - A_NAME", '4: "A_NAME" is declared twice'],
    [
      "secrets:\n  required:\n    - A_NAME\n  optional:\n    - A_NAME",
      '5: "A_NAME" is declared twice',
    ],
    ["secrets:\n  required:\n      deeper: x", '3: expected a "- NAME" list item'],
    [
      "secrets:\n  required:\n  - A_NAME",
      '3: a name must sit under "secrets.required" or "secrets.optional"',
    ],
  ])("refuses %j with its line and reason", (text, reason) => {
    expect(reasonOf(text)).toBe(reason);
  });

  it("refuses a twenty-first name, so a hostile file cannot fill the card", () => {
    const names = Array.from({ length: 21 }, (_, index) => `    - NAME_${index}`);
    expect(reasonOf(["secrets:", "  optional:", ...names].join("\n"))).toBe(
      "23: at most 20 secrets may be declared",
    );
    expect(reasonOf(["secrets:", "  optional:", ...names.slice(0, 20)].join("\n"))).toBe("ok");
  });

  it("closes the list when a new top-level key starts", () => {
    expect(
      reasonOf("secrets:\n  required:\n    - A_NAME\npreview:\n  port: 3000\n  health_path: /"),
    ).toBe("ok");
    expect(reasonOf("secrets:\n  required:\n    - A_NAME\nversion: 1\n    - B_NAME")).toBe(
      "5: lists, anchors, and aliases are not supported",
    );
  });
});

describe("describeDefinition", () => {
  it("lists each resolved command with the layer that answered it, and the preview", () => {
    const detected: DetectedCommands = {
      ...NO_COMMANDS,
      test: "npm run test",
      lint: "npm run lint",
    };
    const file: ProjectFile = {
      commands: { test: "pnpm test --run" },
      preview: { port: 3000, health_path: "/" },
    };
    expect(describeDefinition(resolve(detected, file))).toBe(
      "environment definition: test = pnpm test --run (.oncue/project.yaml); lint = npm run lint (detected); preview on port 3000 at / (.oncue/project.yaml)",
    );
  });

  it("bounds a command the repository file made very long", () => {
    const file: ProjectFile = { commands: { test: "x".repeat(500) } };
    const line = describeDefinition(resolve(NO_COMMANDS, file));
    expect(line).toBe(`environment definition: test = ${"x".repeat(200)}… (.oncue/project.yaml)`);
  });

  it("says so when nothing resolved", () => {
    expect(describeDefinition(resolve(NO_COMMANDS, null))).toBe(
      "environment definition: no commands resolved",
    );
  });
});

describe("resolve", () => {
  it("falls back to platform defaults (null) when nothing detected and no file", () => {
    const result = resolve(NO_COMMANDS, null);
    expect(result.commands.test).toEqual({ value: null, source: "platform_default" });
    expect(result.commands.dev).toEqual({ value: null, source: "platform_default" });
    expect(result.preview).toEqual({ value: null, source: "platform_default" });
  });

  it("uses a detected command when no file overrides it", () => {
    const detected: DetectedCommands = { ...NO_COMMANDS, test: "npm run test" };
    const result = resolve(detected, null);
    expect(result.commands.test).toEqual({ value: "npm run test", source: "detected" });
  });

  it("lets the repository file override a detected command", () => {
    const detected: DetectedCommands = { ...NO_COMMANDS, test: "npm run test" };
    const file: ProjectFile = { commands: { test: "pnpm test --run" } };
    const result = resolve(detected, file);
    expect(result.commands.test).toEqual({ value: "pnpm test --run", source: "repository_file" });
  });

  it("lets the repository file supply a command detection found nothing for", () => {
    const file: ProjectFile = { commands: { lint: "biome check ." } };
    const result = resolve(NO_COMMANDS, file);
    expect(result.commands.lint).toEqual({ value: "biome check .", source: "repository_file" });
    expect(result.commands.build).toEqual({ value: null, source: "platform_default" });
  });

  it("resolves preview from the file when present, layered over the platform default", () => {
    const file: ProjectFile = { preview: { port: 3000, health_path: "/" } };
    const result = resolve(NO_COMMANDS, file);
    expect(result.preview).toEqual({
      value: { port: 3000, health_path: "/" },
      source: "repository_file",
    });
  });

  it("resolves every command field independently across all three layers at once", () => {
    const detected: DetectedCommands = {
      test: "npm run test",
      lint: "npm run lint",
      typecheck: null,
      build: "npm run build",
      dev: null,
    };
    const file: ProjectFile = { commands: { lint: "biome check .", typecheck: "tsc --noEmit" } };
    const result = resolve(detected, file);
    expect(result.commands).toEqual({
      test: { value: "npm run test", source: "detected" },
      lint: { value: "biome check .", source: "repository_file" },
      typecheck: { value: "tsc --noEmit", source: "repository_file" },
      build: { value: "npm run build", source: "detected" },
      dev: { value: null, source: "platform_default" },
    });
  });
});

describe("detectInstall", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
  ])("installs from %s with %s", (lockfile, command) => {
    expect(detectInstall(filesOf({ "package.json": "{}", [lockfile]: "" }))).toEqual({
      command,
      lockfile,
    });
  });

  it("prefers pnpm's lockfile when a repository committed several, as detect does", () => {
    expect(
      detectInstall(filesOf({ "package-lock.json": "", "pnpm-lock.yaml": "" }))?.lockfile,
    ).toBe("pnpm-lock.yaml");
  });

  it("installs nothing without a lockfile", () => {
    expect(detectInstall(filesOf({ "package.json": "{}" }))).toBeNull();
  });
});
