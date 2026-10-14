import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { foreignSlotOrigins, type SlotPorts, slotPorts } from "../../scripts/dev-ports.mjs";
import { clerkStandInPlugin } from "./vite-plugins/clerk-stand-in.ts";
import { devHarnessPlugin } from "./vite-plugins/dev-harness.ts";
import { devInspectPlugin } from "./vite-plugins/dev-inspect.ts";

function shortSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function readyLinePlugin(ports: SlotPorts): Plugin {
  return {
    name: "oncue-ready-line",
    apply: "serve",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();
        const port = address && typeof address === "object" ? address.port : ports.app;
        console.log(`[oncue] ready http://localhost:${port} env=local release=${shortSha()}`);
      });
    },
  };
}

/**
 * The dev server reads `.dev.vars` once, so a file composed for another port
 * slot would point this stack at another checkout's doubles. Refused before
 * anything listens.
 */
function refuseForeignSlotVars(ports: SlotPorts): void {
  let text: string;
  try {
    text = readFileSync(fileURLToPath(new URL("./.dev.vars", import.meta.url)), "utf8");
  } catch {
    return;
  }
  const problems = foreignSlotOrigins(text, ports);
  if (problems.length > 0) {
    throw new Error(
      `apps/web/.dev.vars was composed for another port slot: ${problems.join("; ")}. Run \`ONCUE_PORT_SLOT=${ports.slot} node apps/web/e2e/setup-local-auth.mjs\` (or start this slot with \`ONCUE_PORT_SLOT=${ports.slot} pnpm dev\`) and try again.`,
    );
  }
}

export default defineConfig(({ command }) => {
  // Every port is the slot's (`scripts/dev-ports.mjs`), so several checkouts
  // can each serve a stack on one machine.
  const ports = slotPorts();
  if (command === "serve") {
    refuseForeignSlotVars(ports);
  }
  // `pnpm deploy:hosted` builds from the config it generated for this
  // deployment (`scripts/hosted-config.mjs`). Everything else reads the
  // tracked `wrangler.jsonc`, the plugin's default.
  const wranglerConfig = process.env.ONCUE_WRANGLER_CONFIG;
  return {
    // `devInspectPlugin()` must precede `cloudflare()`: `configureServer`
    // middlewares run in this array's order.
    plugins: [
      devInspectPlugin(),
      devHarnessPlugin(),
      clerkStandInPlugin(),
      react(),
      tailwindcss(),
      // A fixed inspector port per slot: the plugin's default takes the first
      // free port from 9229, which may be the one the next slot expects.
      cloudflare({
        inspectorPort: ports.inspector,
        ...(wranglerConfig === undefined ? {} : { configPath: wranglerConfig }),
      }),
      readyLinePlugin(ports),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    // The dev harnesses are entry points too. Otherwise Vite discovers their
    // dependencies on first visit and reloads the page mid-navigation.
    optimizeDeps: {
      entries: ["index.html", "src/dev/*.tsx"],
    },
    server: {
      // Strict, because on a taken port Vite would move to the next one, and
      // the tests and doubles would still look for this slot's.
      port: ports.app,
      strictPort: true,
      // `pnpm controller` opens a cloudflared tunnel so a real sandbox's bridge
      // can reach the local Worker; Vite rejects unknown Host headers, so the
      // tunnel's hostnames are allowed. Dev server only.
      allowedHosts: [".trycloudflare.com"],
    },
  };
});
