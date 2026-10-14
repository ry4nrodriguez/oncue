// Verifies a Clerk session token against the public JWT key, with no secret
// key and no network call. `@clerk/backend` exports only a `verifyToken` that
// throws on a bad or expired token, so the `catch` below turns that into
// `unverified`; nothing in `worker/auth/` throws.
//
// `authorizedParties` is the request's own origin (record 01). A browser never
// sends an Authorization header here, so one being present is refused.

import { verifyToken } from "@clerk/backend";

export type ClerkVerification =
  | { readonly kind: "verified"; readonly subject: string }
  | { readonly kind: "unverified" };

const SESSION_COOKIE_NAME = "__session";

/**
 * Plain `__session` first, then any `__session_<suffix>`: Clerk's client may
 * write only the suffixed form. The name proves nothing; the first candidate
 * that verifies wins.
 */
function sessionCookieCandidates(cookieHeader: string | null): readonly string[] {
  if (cookieHeader === null) {
    return [];
  }
  const cookies = cookieHeader.split(";").map((entry) => entry.trim());
  const plain: string[] = [];
  const suffixed: string[] = [];
  for (const entry of cookies) {
    if (entry.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      plain.push(decodeURIComponent(entry.slice(SESSION_COOKIE_NAME.length + 1)));
    } else if (entry.startsWith(`${SESSION_COOKIE_NAME}_`)) {
      const equals = entry.indexOf("=");
      if (equals > 0) {
        suffixed.push(decodeURIComponent(entry.slice(equals + 1)));
      }
    }
  }
  return [...plain, ...suffixed];
}

export async function verifyClerkSession(
  request: Request,
  jwtKey: string,
): Promise<ClerkVerification> {
  if (request.headers.has("authorization")) {
    return { kind: "unverified" };
  }
  const origin = new URL(request.url).origin;
  for (const token of sessionCookieCandidates(request.headers.get("cookie"))) {
    try {
      const claims = await verifyToken(token, { jwtKey, authorizedParties: [origin] });
      return { kind: "verified", subject: claims.sub };
    } catch {
      // A stale or foreign cookie beside the live one is ordinary.
    }
  }
  return { kind: "unverified" };
}
