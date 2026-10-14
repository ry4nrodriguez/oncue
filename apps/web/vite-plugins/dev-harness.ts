/**
 * Dev-only entry points for end-to-end tests. `apply:
 * "serve"` keeps them out of the build, whose single entry is `index.html`.
 *
 * The app sits behind Clerk with no bypass, so these let Playwright reach the
 * screens without live credentials. `/dev/session` renders real components
 * against scripted fixtures; `/dev/home` stubs only the
 * identity, so the real Worker's 401 is what it shows.
 *
 * The literal paths belong only here and in this file's test, never in
 * `apps/web/worker/**`; `scripts/check-no-dev-harness.mjs` fails the build if
 * one reaches `dist`.
 */
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { slotPorts } from "../../../scripts/dev-ports.mjs";
import { devSignInCookie } from "../e2e/lane-auth.ts";

const HARNESS_ENTRIES: Record<string, { title: string; module: string }> = {
  "/dev/session": { title: "OnCue session harness", module: "/src/dev/session-harness.tsx" },
  "/dev/home": { title: "OnCue home harness", module: "/src/dev/home-harness.tsx" },
};

/**
 * The whole app, signed in, with only Clerk's browser SDK stood in for. Served
 * on the product's own paths because the browser router needs the real URL.
 * The cookie `/dev/sign-in` sets switches these paths to this entry; without
 * it, `pnpm dev:real` and a plain visit get the real sign-in.
 */
const APP_HARNESS = { title: "OnCue", module: "/src/dev/app-harness.tsx" };
export const DEV_APP_COOKIE = "oncue_dev_app";

function hasDevAppCookie(cookieHeader: string | undefined): boolean {
  return (cookieHeader ?? "").split(";").some((entry) => entry.trim() === `${DEV_APP_COOKIE}=1`);
}

/**
 * A GET for an extensionless path outside the Worker's and Vite's own
 * prefixes: the URLs Vite falls back to `index.html` for.
 */
function isAppNavigation(pathname: string): boolean {
  // Vite's own module paths (`/@vite/client`, `/@fs/...`) have no extension.
  if (pathname.startsWith("/@")) {
    return false;
  }
  if (/^\/(api|ws|dev|cdn-cgi|__|src|node_modules)(\/|$)/.test(pathname)) {
    return false;
  }
  return !/\.[a-z0-9]+$/i.test(pathname);
}

export function appHarnessEntryFor(
  url: string | undefined,
  cookieHeader: string | undefined,
): { title: string; module: string } | null {
  if (url === undefined || !hasDevAppCookie(cookieHeader)) {
    return null;
  }
  const pathname = url.split("?")[0] ?? url;
  return isAppNavigation(pathname) ? APP_HARNESS : null;
}

/**
 * `GET /dev/sign-in` mints the RS256 session cookie the Playwright tests use,
 * signed with the private key `e2e/setup-local-auth.mjs` left in `.dev.vars`,
 * and redirects. The Worker verifies it with its real `verifyClerkSession`,
 * so nothing in the product is bypassed. `?as=<subject>` picks a subject.
 */
export const DEV_SIGN_IN_PATH = "/dev/sign-in";

/**
 * The origin the browser uses, which the cookie's authorized party must equal.
 * Behind the https tunnel `pnpm controller` opens, `x-forwarded-proto` says
 * https. With no Host header, the port slot's app port stands in.
 */
export function devSignInOrigin(
  host: string | undefined,
  forwardedProto?: string,
  appPort: number = slotPorts().app,
): string {
  const scheme = forwardedProto === "https" ? "https" : "http";
  return `${scheme}://${host ?? `localhost:${appPort}`}`;
}

export function signInRedirect(
  url: string,
  host: string | undefined,
  forwardedProto?: string,
): { readonly cookies: readonly string[]; readonly location: string } | null {
  const [pathname, query] = url.split("?");
  if (pathname?.replace(/\/$/, "") !== DEV_SIGN_IN_PATH) {
    return null;
  }
  const params = new URLSearchParams(query ?? "");
  const origin = devSignInOrigin(host, forwardedProto);
  const minted = devSignInCookie(origin, params.get("as") ?? undefined);
  return {
    cookies: [
      `${minted.cookie}; Path=/; SameSite=Lax; HttpOnly`,
      `${DEV_APP_COOKIE}=1; Path=/; SameSite=Lax`,
    ],
    location: params.get("to") ?? "/",
  };
}

/**
 * `GET /dev/sign-out` clears the two cookies `/dev/sign-in` set and returns
 * to `/`. Clerk's own sign-out cannot end a session Clerk never held, so the
 * stand-in for its browser SDK sends "Sign out" here.
 */
export const DEV_SIGN_OUT_PATH = "/dev/sign-out";

export function signOutRedirect(
  url: string,
): { readonly cookies: readonly string[]; readonly location: string } | null {
  if (url.split("?")[0]?.replace(/\/$/, "") !== DEV_SIGN_OUT_PATH) {
    return null;
  }
  return {
    cookies: [
      "__session=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0",
      `${DEV_APP_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`,
    ],
    location: "/",
  };
}

/**
 * `GET /dev/checkout` names the directory this dev server started from.
 * Playwright reuses any server on the slot's app port, so `e2e/same-checkout.ts` stops a
 * run whose server belongs to another checkout.
 */
export const DEV_CHECKOUT_PATH = "/dev/checkout";

export function checkoutAnswer(url: string | undefined, root: string): string | null {
  const pathname = (url ?? "").split("?")[0]?.replace(/\/$/, "");
  return pathname === DEV_CHECKOUT_PATH ? JSON.stringify({ root }) : null;
}

export function harnessEntryFor(url: string | undefined): { title: string; module: string } | null {
  if (url === undefined) {
    return null;
  }
  const pathname = (url.split("?")[0] ?? url).replace(/\/$/, "");
  return HARNESS_ENTRIES[pathname] ?? null;
}

function html(title: string, module: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${module}"></script>
  </body>
</html>
`;
}

export function devHarnessPlugin(): Plugin {
  return {
    name: "oncue-dev-harness",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res, next) => {
        const checkout = req.method === "GET" ? checkoutAnswer(req.url, server.config.root) : null;
        if (checkout !== null) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(checkout);
          return;
        }
        const signIn =
          req.method === "GET"
            ? signInRedirect(
                req.url ?? "",
                req.headers.host,
                req.headers["x-forwarded-proto"]?.toString(),
              )
            : null;
        const redirect = signIn ?? (req.method === "GET" ? signOutRedirect(req.url ?? "") : null);
        if (redirect !== null) {
          res.statusCode = 302;
          res.setHeader("set-cookie", [...redirect.cookies]);
          res.setHeader("location", redirect.location);
          res.end();
          return;
        }
        const entry =
          req.method === "GET"
            ? (harnessEntryFor(req.url) ?? appHarnessEntryFor(req.url, req.headers.cookie))
            : null;
        if (entry === null) {
          next();
          return;
        }
        const transformed = await server.transformIndexHtml(
          req.url ?? "/dev",
          html(entry.title, entry.module),
        );
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(transformed);
      });
    },
  };
}
