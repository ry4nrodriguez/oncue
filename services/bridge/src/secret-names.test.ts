import { describe, expect, it } from "vitest";
import {
  isSecretName,
  MAX_SECRET_VALUE_BYTES,
  MIN_SECRET_VALUE_CHARS,
  refuseSecretName,
  refuseSecretValue,
} from "./secret-names";

describe("a secret's name", () => {
  it.each(["DATABASE_URL", "A", "X9_", "STRIPE_TEST_KEY", `A${"B".repeat(63)}`])(
    "accepts %s",
    (name) => {
      expect(isSecretName(name)).toBe(true);
      expect(refuseSecretName(name)).toBeNull();
    },
  );

  it.each([
    "",
    "database_url",
    "9LIVES",
    "_LEADING",
    "HAS SPACE",
    "HAS-DASH",
    "NEW\nLINE",
    "../ESCAPE",
    `A${"B".repeat(64)}`,
  ])("refuses the malformed %j", (name) => {
    expect(isSecretName(name)).toBe(false);
    expect(refuseSecretName(name)).toBe("malformed");
  });

  it.each([
    "PATH",
    "HOME",
    "CI",
    "NODE_OPTIONS",
    "BASH_ENV",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_SSH_COMMAND",
    "XDG_CONFIG_HOME",
    "LC_ALL",
    "ONCUE_BRIDGE_BOOTSTRAP",
    "OPENCODE_CONFIG_CONTENT",
  ])("refuses the reserved %s", (name) => {
    expect(refuseSecretName(name)).toBe("reserved");
  });

  it.each([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "MODAL_TOKEN_SECRET",
    "CLERK_SECRET_KEY",
    "CLOUDFLARE_API_TOKEN",
  ])("refuses the platform credential %s", (name) => {
    expect(refuseSecretName(name)).toBe("platform_credential");
  });
});

describe("a secret's value", () => {
  it("accepts an ordinary value", () => {
    expect(refuseSecretValue("postgres://fake:fake@localhost/dev")).toBeNull();
  });

  it("refuses a value the redactor could not protect", () => {
    expect(refuseSecretValue("x".repeat(MIN_SECRET_VALUE_CHARS - 1))).toBe("too_short");
    expect(refuseSecretValue("x".repeat(MIN_SECRET_VALUE_CHARS))).toBeNull();
  });

  it("refuses a value larger than the supervisor would pass on, measured in bytes", () => {
    expect(refuseSecretValue("x".repeat(MAX_SECRET_VALUE_BYTES))).toBeNull();
    expect(refuseSecretValue("x".repeat(MAX_SECRET_VALUE_BYTES + 1))).toBe("too_long");
    expect(refuseSecretValue("é".repeat(MAX_SECRET_VALUE_BYTES / 2 + 1))).toBe("too_long");
  });

  it.each(["fake-value\nSECOND=1", "fake-value\r", "fake-value\0tail"])(
    "refuses %j, which could smuggle a second value",
    (value) => {
      expect(refuseSecretValue(value)).toBe("control_character");
    },
  );
});
