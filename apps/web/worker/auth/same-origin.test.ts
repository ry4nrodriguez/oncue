import { describe, expect, it } from "vitest";
import { extractBrokerTokenSessionId, extractForwardSessionId } from "../routes/broker";
import {
  classifyRequestOrigin,
  crossSiteRequestResponse,
  decideSameOrigin,
  isSameOriginExempt,
  isWebSocketUpgrade,
  refuseCrossSiteRequest,
  SAME_ORIGIN_EXEMPTIONS,
  type SameOriginVerdict,
} from "./same-origin";

const OWN_ORIGIN = "https://oncue.example";
const URL_UNDER_TEST = `${OWN_ORIGIN}/api/model-connections`;

function requestWith(headers: Record<string, string>, method = "POST"): Request {
  return new Request(URL_UNDER_TEST, { method, headers });
}

describe("classifyRequestOrigin", () => {
  describe("Sec-Fetch-Site, the primary signal", () => {
    const cases: readonly [string, SameOriginVerdict][] = [
      ["same-origin", "same_origin"],
      ["none", "same_origin"],
      ["same-site", "cross_site"],
      ["cross-site", "cross_site"],
    ];

    for (const [value, verdict] of cases) {
      it(`reads ${value} as ${verdict}`, () => {
        expect(classifyRequestOrigin(requestWith({ "sec-fetch-site": value }))).toBe(verdict);
      });
    }

    it("fails closed on a value no browser sends", () => {
      expect(classifyRequestOrigin(requestWith({ "sec-fetch-site": "bogus" }))).toBe("cross_site");
    });

    it("is authoritative when present: a matching Origin does not rescue cross-site", () => {
      const request = requestWith({ "sec-fetch-site": "cross-site", origin: OWN_ORIGIN });

      expect(classifyRequestOrigin(request)).toBe("cross_site");
    });

    it("is authoritative when present: same-origin is not overturned by a foreign Origin", () => {
      const request = requestWith({
        "sec-fetch-site": "same-origin",
        origin: "https://evil.example",
      });

      expect(classifyRequestOrigin(request)).toBe("same_origin");
    });
  });

  describe("Origin, the fallback", () => {
    it("accepts an Origin equal to the request URL's origin", () => {
      expect(classifyRequestOrigin(requestWith({ origin: OWN_ORIGIN }))).toBe("same_origin");
    });

    const mismatches: readonly [string, string][] = [
      ["a different host", "https://evil.example"],
      ["a suffix trick", "https://oncue.example.evil"],
      ["a prefix trick", "https://evil-oncue.example"],
      ["a different scheme", "http://oncue.example"],
      ["a different port", "https://oncue.example:8443"],
      ["the opaque origin a sandboxed frame sends", "null"],
      ["a value that is not an origin at all", "not an origin"],
      ["a trailing slash", "https://oncue.example/"],
    ];

    for (const [what, origin] of mismatches) {
      it(`refuses ${what}`, () => {
        expect(classifyRequestOrigin(requestWith({ origin }))).toBe("cross_site");
      });
    }
  });

  it("answers unknown_client when neither header is present, which is not a browser", () => {
    expect(classifyRequestOrigin(requestWith({}))).toBe("unknown_client");
  });
});

describe("decideSameOrigin", () => {
  const verdicts: readonly SameOriginVerdict[] = ["same_origin", "cross_site", "unknown_client"];

  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    it(`allows ${method} whatever the verdict, because it is not state-changing`, () => {
      for (const verdict of verdicts) {
        expect(decideSameOrigin(method, verdict, false)).toBe("allow");
      }
    });
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "PROPFIND"]) {
    it(`guards ${method}: same_origin and unknown_client pass, cross_site is refused`, () => {
      expect(decideSameOrigin(method, "same_origin", false)).toBe("allow");
      expect(decideSameOrigin(method, "unknown_client", false)).toBe("allow");
      expect(decideSameOrigin(method, "cross_site", false)).toBe("refuse");
    });
  }

  it("guards a WebSocket upgrade even though it is a GET", () => {
    expect(decideSameOrigin("GET", "cross_site", true)).toBe("refuse");
    expect(decideSameOrigin("GET", "same_origin", true)).toBe("allow");
    expect(decideSameOrigin("GET", "unknown_client", true)).toBe("allow");
  });
});

describe("isWebSocketUpgrade", () => {
  it("reads the RFC 6455 token case-insensitively", () => {
    expect(isWebSocketUpgrade(requestWith({ upgrade: "websocket" }, "GET"))).toBe(true);
    expect(isWebSocketUpgrade(requestWith({ upgrade: "WebSocket" }, "GET"))).toBe(true);
  });

  it("is false for no Upgrade header and for another protocol", () => {
    expect(isWebSocketUpgrade(requestWith({}, "GET"))).toBe(false);
    expect(isWebSocketUpgrade(requestWith({ upgrade: "h2c" }, "GET"))).toBe(false);
  });
});

describe("crossSiteRequestResponse", () => {
  it("is a 403 in the shape authorize.ts gives its denials", async () => {
    const response = crossSiteRequestResponse();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_site_request" });
  });
});

describe("SAME_ORIGIN_EXEMPTIONS", () => {
  it("exempts the GitHub webhook, whose signature is its authentication", () => {
    expect(isSameOriginExempt("POST", "/api/github/webhook")).toBe(true);
  });

  it("does not exempt a different method on an exempt path", () => {
    expect(isSameOriginExempt("PUT", "/api/github/webhook")).toBe(false);
  });

  it("does not exempt a path that merely resembles an exempt one", () => {
    expect(isSameOriginExempt("POST", "/api/github/webhooks")).toBe(false);
    expect(isSameOriginExempt("POST", "/api/broker/token/refresh/extra")).toBe(false);
    expect(isSameOriginExempt("POST", "/api/broker/sessions/v1/messages")).toBe(false);
  });

  it("exempts exactly the forwarding paths worker/routes/broker.ts routes", () => {
    const candidates = [
      "/api/broker/sessions/sess_1/v1/messages",
      "/api/broker/sessions/sess_1/v1/other",
      "/api/broker/sessions//v1/messages",
      "/api/broker/sessions/sess_1/v1/messages/",
    ];

    for (const pathname of candidates) {
      expect(isSameOriginExempt("POST", pathname)).toBe(extractForwardSessionId(pathname) !== null);
    }
  });

  it("exempts the refresh path", () => {
    expect(isSameOriginExempt("POST", "/api/broker/token/refresh")).toBe(true);
  });

  // The broker-token route is cookie-authenticated, so it must stay guarded.
  it("does NOT exempt the owner-authenticated broker-token route", () => {
    const pathname = "/api/sessions/sess_1/broker-token";

    expect(extractBrokerTokenSessionId(pathname)).toBe("sess_1");
    expect(isSameOriginExempt("POST", pathname)).toBe(false);
  });

  it("names something other than a cookie as every exemption's authentication", () => {
    for (const exemption of SAME_ORIGIN_EXEMPTIONS) {
      expect(exemption.authenticatedBy).not.toMatch(/cookie/i);
    }
  });
});

describe("refuseCrossSiteRequest", () => {
  it("lets an exempt route through even when the browser says cross-site", () => {
    const request = new Request(`${OWN_ORIGIN}/api/github/webhook`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(refuseCrossSiteRequest(request)).toBeNull();
  });

  it("refuses a cross-site state-changing request with the 403 shape", async () => {
    const refusal = refuseCrossSiteRequest(requestWith({ origin: "https://evil.example" }));

    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(403);
    expect(await refusal?.json()).toEqual({ error: "cross_site_request" });
  });

  it("lets a same-origin state-changing request through", () => {
    expect(refuseCrossSiteRequest(requestWith({ origin: OWN_ORIGIN }))).toBeNull();
  });

  it("lets a read through whatever its origin", () => {
    expect(
      refuseCrossSiteRequest(requestWith({ origin: "https://evil.example" }, "GET")),
    ).toBeNull();
  });

  // A cookie-authenticated handshake has no same-origin policy of its own, so
  // a foreign page could otherwise stream a user's timeline.
  it("refuses a cross-site WebSocket upgrade despite it being a GET", () => {
    const request = new Request(`${OWN_ORIGIN}/ws/sess_1`, {
      method: "GET",
      headers: { upgrade: "websocket", origin: "https://evil.example" },
    });

    expect(refuseCrossSiteRequest(request)?.status).toBe(403);
  });

  it("lets a same-origin WebSocket upgrade through", () => {
    const request = new Request(`${OWN_ORIGIN}/ws/sess_1`, {
      method: "GET",
      headers: { upgrade: "websocket", origin: OWN_ORIGIN },
    });

    expect(refuseCrossSiteRequest(request)).toBeNull();
  });

  // A browser always sends `Origin` on a handshake, so neither header means a
  // non-browser client.
  it("lets an upgrade with no Origin through as an unknown client", () => {
    const request = new Request(`${OWN_ORIGIN}/ws/sess_1`, {
      method: "GET",
      headers: { upgrade: "websocket" },
    });

    expect(refuseCrossSiteRequest(request)).toBeNull();
  });
});
