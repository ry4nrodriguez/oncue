// @vitest-environment node
import { describe, expect, it } from "vitest";
import { portsForSlot } from "../../../scripts/dev-ports.mjs";
import { appOriginCandidates } from "./app-origin";
import { foreignServerAdvice } from "./same-checkout";

describe("appOriginCandidates", () => {
  it("probes the same three spellings of port 5173 on slot 0 as before slots existed", () => {
    expect(appOriginCandidates(portsForSlot(0))).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
    ]);
  });

  it("probes only the slot's own app port, never another slot's", () => {
    expect(appOriginCandidates(portsForSlot(12))).toEqual([
      "http://localhost:6373",
      "http://127.0.0.1:6373",
      "http://[::1]:6373",
    ]);
  });
});

describe("foreignServerAdvice", () => {
  it("names this slot's ports and the way to another slot", () => {
    const advice = foreignServerAdvice(portsForSlot(11));
    expect(advice).toContain("lsof -ti:6273,6297,6298,6299 | xargs kill");
    expect(advice).toContain("ONCUE_PORT_SLOT=N");
    expect(foreignServerAdvice(portsForSlot(0))).toContain(
      "lsof -ti:5173,5197,5198,5199 | xargs kill",
    );
  });
});
