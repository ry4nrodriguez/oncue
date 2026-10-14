// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clerkStandInPlugin, configuredClerkKey, STAND_IN_PUBLISHABLE_KEY } from "./clerk-stand-in";

function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oncue-clerk-key-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

/** The plugin's `config` hook, called as Vite calls it. */
function configOf(plugin: ReturnType<typeof clerkStandInPlugin>): Record<string, unknown> {
  const hook = plugin.config;
  if (typeof hook !== "function") {
    throw new Error("the plugin has no config hook");
  }
  return hook.call({} as never, {}, { command: "serve", mode: "development" }) as Record<
    string,
    unknown
  >;
}

describe("configuredClerkKey", () => {
  it("is null on a fresh clone, which has no key anywhere", () => {
    expect(configuredClerkKey(rootWith({}), {})).toBeNull();
  });

  it("reads a developer's own key from .env.local", () => {
    const root = rootWith({ ".env.local": "VITE_CLERK_PUBLISHABLE_KEY=pk_test_mine\n" });
    expect(configuredClerkKey(root, {})).toBe("pk_test_mine");
  });

  it("lets the process environment win over the env files", () => {
    const root = rootWith({ ".env.local": "VITE_CLERK_PUBLISHABLE_KEY=pk_test_file\n" });
    expect(configuredClerkKey(root, { VITE_CLERK_PUBLISHABLE_KEY: "pk_test_shell" })).toBe(
      "pk_test_shell",
    );
  });

  it("prefers the more specific env file, as Vite does, and reads a quoted value", () => {
    const root = rootWith({
      ".env": "VITE_CLERK_PUBLISHABLE_KEY=pk_test_shared\n",
      ".env.local": 'OTHER=1\nVITE_CLERK_PUBLISHABLE_KEY="pk_test_local"\n',
    });
    expect(configuredClerkKey(root, {})).toBe("pk_test_local");
  });

  it("treats a blank value as no key", () => {
    const root = rootWith({ ".env.local": "VITE_CLERK_PUBLISHABLE_KEY=\n" });
    expect(configuredClerkKey(root, { VITE_CLERK_PUBLISHABLE_KEY: "  " })).toBeNull();
  });
});

describe("clerkStandInPlugin", () => {
  it("never applies to a build, so the stand-in cannot ship", () => {
    expect(clerkStandInPlugin(null).apply).toBe("serve");
    expect(clerkStandInPlugin("pk_test_mine").apply).toBe("serve");
  });

  it("swaps the bare package for the stand-in when no key is set", () => {
    const config = configOf(clerkStandInPlugin(null)) as {
      resolve: { alias: { find: RegExp; replacement: string }[] };
      define: Record<string, string>;
    };
    const [alias] = config.resolve.alias;
    expect(alias?.replacement.endsWith("/src/dev/clerk-stand-in.tsx")).toBe(true);
    expect(alias?.find.test("@clerk/react")).toBe(true);
    expect(alias?.find.test("@clerk/react/internal")).toBe(false);
    expect(alias?.find.test("@clerk/backend")).toBe(false);
    expect(config.define["import.meta.env.VITE_CLERK_PUBLISHABLE_KEY"]).toBe(
      JSON.stringify(STAND_IN_PUBLISHABLE_KEY),
    );
  });

  it("leaves Clerk's real SDK alone when a key is set", () => {
    expect(configOf(clerkStandInPlugin("pk_test_mine"))).toEqual({});
  });
});
