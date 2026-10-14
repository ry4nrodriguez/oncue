import { describe, expect, it } from "vitest";
import { type ControllerBindings, readControllerConfig } from "./origin";

const CONFIGURED: ControllerBindings = {
  ONCUE_SANDBOX_CONTROLLER_ORIGIN: "https://oncue--controller.modal.run",
  ONCUE_SANDBOX_CONTROLLER_TOKEN: "controller-token",
};

describe("readControllerConfig", () => {
  // No Modal credential here: the user's token pair comes from `modal_connection`.
  it("reads a complete configuration", () => {
    expect(readControllerConfig(CONFIGURED, "hosted")).toEqual({
      kind: "configured",
      settings: {
        origin: "https://oncue--controller.modal.run",
        controllerToken: "controller-token",
      },
    });
  });

  it("trims, because a pasted secret often arrives with a newline on it", () => {
    expect(
      readControllerConfig(
        { ...CONFIGURED, ONCUE_SANDBOX_CONTROLLER_TOKEN: " controller-token\n" },
        "hosted",
      ),
    ).toMatchObject({ settings: { controllerToken: "controller-token" } });
  });

  it("is unconfigured when nothing is set at all", () => {
    expect(readControllerConfig({}, "hosted")).toEqual({ kind: "unconfigured" });
  });

  it.each(["ONCUE_SANDBOX_CONTROLLER_ORIGIN", "ONCUE_SANDBOX_CONTROLLER_TOKEN"] as const)(
    "is unconfigured when %s is missing",
    (key) => {
      expect(readControllerConfig({ ...CONFIGURED, [key]: undefined }, "hosted")).toEqual({
        kind: "unconfigured",
      });
    },
  );

  it.each(["ONCUE_SANDBOX_CONTROLLER_ORIGIN", "ONCUE_SANDBOX_CONTROLLER_TOKEN"] as const)(
    "is unconfigured when %s is blank, which is how the test runner clears it",
    (key) => {
      expect(readControllerConfig({ ...CONFIGURED, [key]: "   " }, "hosted")).toEqual({
        kind: "unconfigured",
      });
    },
  );

  it("refuses a plain-HTTP controller in a hosted deployment", () => {
    // The user's Modal token pair travels on every request.
    expect(
      readControllerConfig(
        { ...CONFIGURED, ONCUE_SANDBOX_CONTROLLER_ORIGIN: "http://controller.internal" },
        "hosted",
      ),
    ).toEqual({ kind: "unconfigured" });
  });

  it("accepts a plain-HTTP controller locally, where the other end is a double", () => {
    expect(
      readControllerConfig(
        { ...CONFIGURED, ONCUE_SANDBOX_CONTROLLER_ORIGIN: "http://127.0.0.1:5200" },
        "local",
      ),
    ).toMatchObject({ kind: "configured" });
  });

  it("refuses an origin that is neither http nor https, even locally", () => {
    expect(
      readControllerConfig(
        { ...CONFIGURED, ONCUE_SANDBOX_CONTROLLER_ORIGIN: "controller.internal" },
        "local",
      ),
    ).toEqual({ kind: "unconfigured" });
  });
});
