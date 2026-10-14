import { describe, expect, it } from "vitest";
import { GITHUB_API_ORIGIN, GITHUB_WEB_ORIGIN, resolveGitHubOrigin } from "./origin";

const DOUBLE = "http://127.0.0.1:4318";

describe("resolveGitHubOrigin", () => {
  it("names the two real GitHub hosts, because the flow crosses both", () => {
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
    expect(GITHUB_WEB_ORIGIN).toBe("https://github.com");
  });

  // A hosted deploy with the override set, by mistake or by an attacker with
  // secret access, still talks only to GitHub.
  it("ignores the override outside the local environment", () => {
    expect(resolveGitHubOrigin(GITHUB_API_ORIGIN, "hosted", DOUBLE)).toBe(GITHUB_API_ORIGIN);
    expect(resolveGitHubOrigin(GITHUB_WEB_ORIGIN, "hosted", DOUBLE)).toBe(GITHUB_WEB_ORIGIN);
  });

  it("uses the real origin locally when no override is configured", () => {
    expect(resolveGitHubOrigin(GITHUB_API_ORIGIN, "local", undefined)).toBe(GITHUB_API_ORIGIN);
  });

  it("treats an empty override as no override", () => {
    expect(resolveGitHubOrigin(GITHUB_API_ORIGIN, "local", "")).toBe(GITHUB_API_ORIGIN);
    expect(resolveGitHubOrigin(GITHUB_WEB_ORIGIN, "local", "   ")).toBe(GITHUB_WEB_ORIGIN);
  });

  it("sends both path spaces to the one double locally when the override is set", () => {
    expect(resolveGitHubOrigin(GITHUB_API_ORIGIN, "local", DOUBLE)).toBe(DOUBLE);
    expect(resolveGitHubOrigin(GITHUB_WEB_ORIGIN, "local", DOUBLE)).toBe(DOUBLE);
  });
});
