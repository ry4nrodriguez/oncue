import { describe, expect, it, vi } from "vitest";
import { navigateTo } from "./navigate";

describe("navigateTo", () => {
  it("calls window.location.assign with the given URL", () => {
    // jsdom's `Location.assign` cannot be spied on, so replace the whole object.
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });

    navigateTo("https://github.com/apps/oncue");

    expect(assign).toHaveBeenCalledWith("https://github.com/apps/oncue");
  });
});
