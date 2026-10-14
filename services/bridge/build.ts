/**
 * Bundles the bridge into the single files `services/sandbox-controller/images.py`
 * copies into the sandbox image; the image has no `node_modules`, so everything
 * the bridge needs at run time must be inside the bundle.
 *
 * `.mjs` because there is no package.json beside the bundle to make `.js` load
 * as ESM. The `node18` target is a floor that runs unchanged on the image's
 * Node 24; raising it would change the bundle's bytes for no gain.
 * `bufferutil` and `utf-8-validate` (`ws`'s optional native modules) stay
 * external so the bundle is not tied to the build machine's architecture. The
 * banner supplies a real `require`, without which `ws`'s `require("events")`
 * throws in an ES module at run time.
 */

import { execFileSync } from "node:child_process";
import { type BuildOptions, build } from "esbuild";

const OUTFILE = "dist/bridge.mjs";
// The root supervisor, a separate bundle so the file that runs as root never
// contains the WebSocket client, the relay, or anything else the bridge user needs.
const SUPERVISOR_OUTFILE = "dist/supervisor.mjs";

// Stamped into the bundle so `runtime.connected` names the commit the bridge was
// built from; a build outside a checkout reports "unstamped".
function commitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const sha = commitSha();

const shared: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["bufferutil", "utf-8-validate"],
  ...(sha === null ? {} : { define: { __ONCUE_BRIDGE_VERSION__: JSON.stringify(sha) } }),
  banner: {
    js: [
      'import { createRequire as __oncueCreateRequire } from "node:module";',
      "const require = __oncueCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Readable stack traces from inside a sandbox, where no debugger can attach.
  minify: false,
  sourcemap: false,
  logLevel: "info",
};

await build({ ...shared, entryPoints: ["src/main.ts"], outfile: OUTFILE });
process.stdout.write(`bridge bundled to ${OUTFILE}\n`);

await build({ ...shared, entryPoints: ["src/supervisor.ts"], outfile: SUPERVISOR_OUTFILE });
process.stdout.write(`supervisor bundled to ${SUPERVISOR_OUTFILE}\n`);

// The runtime host a stdio harness runs under. A separate bundle because the
// agent user runs it and must be able to read it, and neither of the other two
// may be readable by the agent.
const RUNTIME_HOST_OUTFILE = "dist/runtime-host.mjs";
await build({
  ...shared,
  entryPoints: ["src/runtime-host-main.ts"],
  outfile: RUNTIME_HOST_OUTFILE,
});
process.stdout.write(`runtime host bundled to ${RUNTIME_HOST_OUTFILE}\n`);

// OnCue's Pi extension, which Pi loads as the agent user, so it is also a
// separate agent-readable file. Pi supplies `@earendil-works/pi-ai` itself.
const PI_EXTENSION_OUTFILE = "dist/pi-extension.mjs";
await build({
  ...shared,
  external: [...(shared.external ?? []), "@earendil-works/pi-ai"],
  entryPoints: ["src/pi-extension-main.ts"],
  outfile: PI_EXTENSION_OUTFILE,
});
process.stdout.write(`pi extension bundled to ${PI_EXTENSION_OUTFILE}\n`);
