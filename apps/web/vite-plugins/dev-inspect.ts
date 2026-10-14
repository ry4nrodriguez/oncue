/**
 * Serves `/dev/inspect` only under `vite dev`. `@cloudflare/vite-plugin`
 * forwards every path it does not own to workerd, so this middleware must run
 * first: that needs `apply: "serve"`, `enforce: "pre"`, and a place before
 * `cloudflare()` in `vite.config.ts`, because middlewares run in plugin order.
 *
 * The literal route belongs only here and in this file's test, never in
 * `apps/web/worker/**`: a string in worker source reaches the built bundle.
 */
import type { Plugin } from "vite";

const INSPECT_PATHS = new Set(["/dev/inspect", "/dev/inspect/"]);

export function isInspectRequestPath(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  const pathname = url.split("?")[0] ?? url;
  return INSPECT_PATHS.has(pathname);
}

const INSPECT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OnCue inspector</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/dev/inspect.tsx"></script>
  </body>
</html>
`;

export function devInspectPlugin(): Plugin {
  return {
    name: "oncue-dev-inspect",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET" || !isInspectRequestPath(req.url)) {
          next();
          return;
        }
        const html = await server.transformIndexHtml(req.url ?? "/dev/inspect", INSPECT_HTML);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(html);
      });
    },
  };
}
