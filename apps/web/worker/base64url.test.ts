import { describe, expect, it } from "vitest";
import { decodeBase64Url, encodeBase64Url } from "./base64url";

describe("encodeBase64Url", () => {
  it("uses the URL alphabet and drops padding", () => {
    // 0xfb 0xff is "+/8=" in standard base64: both substitutions and the
    // padding strip at once.
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("encodes an empty input to an empty string", () => {
    expect(encodeBase64Url(new Uint8Array(0))).toBe("");
  });
});

describe("decodeBase64Url", () => {
  it("round-trips every byte value", () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) {
      bytes[index] = index;
    }

    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });

  it("accepts unpadded input, which is what encodeBase64Url produces", () => {
    expect(decodeBase64Url("-_8")).toEqual(new Uint8Array([0xfb, 0xff]));
  });

  it("answers null rather than throwing on input that is not base64", () => {
    expect(decodeBase64Url("not base64!")).toBeNull();
  });
});
