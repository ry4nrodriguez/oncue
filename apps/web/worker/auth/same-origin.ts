// The CSRF boundary for every cookie-authenticated route. It runs in
// `worker/index.ts` before dispatch and before any cookie is read, so a new
// route is guarded unless listed in `SAME_ORIGIN_EXEMPTIONS`.
//
// `Sec-Fetch-Site`, which page script cannot set, is authoritative when
// present: `same-origin` and `none` pass; `cross-site`, `same-site` (OnCue
// serves one origin), and unknown values are refused. Otherwise `Origin` must
// equal the request's origin exactly. With neither header the request is not
// from a browser page (curl, a test, a sandbox) and is allowed; a non-browser
// holding the cookie is a stolen credential this guard cannot address.
//
// Unsafe methods are guarded (RFC 9110 section 9.2.1), and so are WebSocket
// upgrades: a cookie-authenticated GET with no same-origin policy, which would
// let any page stream a user's timeline. Browsers always send `Origin` on a
// handshake. The refusal is a 403 `{ error: "cross_site_request" }`.

export type SameOriginVerdict = "same_origin" | "cross_site" | "unknown_client";

const SEC_FETCH_SITE_VALUES = ["same-origin", "none", "same-site", "cross-site"] as const;
type SecFetchSite = (typeof SEC_FETCH_SITE_VALUES)[number];

const SEC_FETCH_SITE_VERDICT: Record<SecFetchSite, SameOriginVerdict> = {
  "same-origin": "same_origin",
  none: "same_origin",
  "same-site": "cross_site",
  "cross-site": "cross_site",
};

function isSecFetchSite(value: string): value is SecFetchSite {
  return (SEC_FETCH_SITE_VALUES as readonly string[]).includes(value);
}

/** `url` is optional so a test can pass only a `Request`. */
export function classifyRequestOrigin(request: Request, url?: URL): SameOriginVerdict {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite !== null) {
    return isSecFetchSite(secFetchSite) ? SEC_FETCH_SITE_VERDICT[secFetchSite] : "cross_site";
  }
  const origin = request.headers.get("origin");
  if (origin === null) {
    return "unknown_client";
  }
  return origin === (url ?? new URL(request.url)).origin ? "same_origin" : "cross_site";
}

export type SameOriginDecision = "allow" | "refuse";

// RFC 9110 section 9.2.1. Anything else is guarded, including unserved methods.
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

const GUARDED_DECISION: Record<SameOriginVerdict, SameOriginDecision> = {
  same_origin: "allow",
  cross_site: "refuse",
  unknown_client: "allow",
};

/** RFC 6455 section 4.1: the token is case-insensitive. Recognised by header, not by the `/ws/` path. */
export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export function decideSameOrigin(
  method: string,
  verdict: SameOriginVerdict,
  isUpgrade: boolean,
): SameOriginDecision {
  if (!isUpgrade && SAFE_METHODS.has(method)) {
    return "allow";
  }
  return GUARDED_DECISION[verdict];
}

export function crossSiteRequestResponse(): Response {
  return Response.json({ error: "cross_site_request" }, { status: 403 });
}

export interface SameOriginExemption {
  readonly method: string;
  readonly path: RegExp;
  /** What proves the caller in place of a cookie. Never a cookie. */
  readonly authenticatedBy: string;
}

/**
 * Every state-changing route reachable cross-site; a cookie plays no part in
 * authenticating any of them. `POST /api/sessions/:id/broker-token` is absent
 * because it is cookie-authenticated. The broker patterns must match the
 * extractors in `worker/routes/broker.ts`; the test checks that, so this
 * module does not import from `worker/routes/`.
 */
export const SAME_ORIGIN_EXEMPTIONS: readonly SameOriginExemption[] = [
  // GitHub is always cross-site; the route verifies `X-Hub-Signature-256`
  // before it reads the body.
  {
    method: "POST",
    path: /^\/api\/github\/webhook$/,
    authenticatedBy: "X-Hub-Signature-256 HMAC over the body",
  },
  // Record 06's sandbox-facing broker legs: a bearer model token, no Origin.
  {
    method: "POST",
    path: /^\/api\/broker\/token\/refresh$/,
    authenticatedBy: "bearer model token",
  },
  {
    method: "POST",
    path: /^\/api\/broker\/sessions\/[^/]+\/v1\/messages$/,
    authenticatedBy: "bearer model token",
  },
];

export function isSameOriginExempt(method: string, pathname: string): boolean {
  return SAME_ORIGIN_EXEMPTIONS.some(
    (exemption) => exemption.method === method && exemption.path.test(pathname),
  );
}

/** `null` to proceed, or the refusal to return as-is. */
export function refuseCrossSiteRequest(request: Request): Response | null {
  const url = new URL(request.url);
  if (isSameOriginExempt(request.method, url.pathname)) {
    return null;
  }
  const decision = decideSameOrigin(
    request.method,
    classifyRequestOrigin(request, url),
    isWebSocketUpgrade(request),
  );
  return decision === "allow" ? null : crossSiteRequestResponse();
}
