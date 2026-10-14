/**
 * Runs the real sandbox controller on this machine, against real Modal.
 *
 * `app.py`'s FastAPI `api` runs under uvicorn here as it does under Modal's
 * ASGI host, on the port slot's controller port (5197 on slot 0), where the
 * local Worker points, with the controller token read from `apps/web/.dev.vars`
 * so both sides agree. Run it with the same `ONCUE_PORT_SLOT` as the dev
 * server (`scripts/dev-ports.mjs`).
 *
 * The controller holds no Modal credential; each request carries the
 * workspace's pair. It does need `ONCUE_CONTROL_PLANE_ORIGIN`, the https
 * origin a sandbox's bridge dials, which cannot be localhost:
 *
 *   ONCUE_CONTROL_PLANE_ORIGIN=https://... pnpm controller    use that origin
 *   pnpm controller                                            open a quick
 *       cloudflared tunnel to the slot's dev server and use its origin
 *   pnpm controller --dry-run                                  print the port
 *       and the tunnel target, then exit without building or serving
 *
 * A quick tunnel needs `cloudflared` on PATH and no account. Every session
 * then creates a real sandbox in your Modal workspace and spends real credit,
 * which this script says before serving.
 */

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { originsFor, slotPortsOrExit } from "./dev-ports.mjs";
import { DEV_VARS, readVars, repoRoot } from "./dev-vars.mjs";

const controllerRoot = `${repoRoot}services/sandbox-controller`;

/**
 * What this script serves and tunnels to on a slot: uvicorn on the slot's
 * controller port, and the quick tunnel to the slot's dev server, which is
 * the origin a sandbox's bridge dials back to.
 *
 * @param {import("./dev-ports.d.mts").SlotPorts} ports
 * @returns {{ uvicornArgs: string[], tunnelArgs: string[] }}
 */
export function controllerPlan(ports) {
  return {
    uvicornArgs: [
      "run",
      "--frozen",
      "uvicorn",
      "app:api",
      "--host",
      "127.0.0.1",
      "--port",
      String(ports.controller),
    ],
    tunnelArgs: ["tunnel", "--url", originsFor(ports).app],
  };
}

const children = [];

// Imported by its unit test as a module; only a direct invocation serves.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ports = slotPortsOrExit("controller");
  const plan = controllerPlan(ports);
  if (process.argv.includes("--dry-run")) {
    console.log(`[controller] port slot ${ports.slot}`);
    console.log(`[controller] would serve: uv ${plan.uvicornArgs.join(" ")}`);
    console.log(`[controller] would tunnel: cloudflared ${plan.tunnelArgs.join(" ")}`);
  } else {
    await serve(plan);
  }
}

async function serve(plan) {
  const vars = readVars(DEV_VARS);
  const token = vars.get("ONCUE_SANDBOX_CONTROLLER_TOKEN");
  if (token === undefined || token.length === 0) {
    console.error(
      "[controller] apps/web/.dev.vars has no ONCUE_SANDBOX_CONTROLLER_TOKEN; run `pnpm dev:modal` first so the Worker and this controller share one",
    );
    process.exit(1);
  }

  process.on("SIGINT", () => {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    process.exit(0);
  });

  let origin = process.env.ONCUE_CONTROL_PLANE_ORIGIN;
  if (origin === undefined || origin.length === 0) {
    origin = await openQuickTunnel(plan.tunnelArgs);
  }
  if (!origin.startsWith("https://")) {
    console.error(`[controller] ONCUE_CONTROL_PLANE_ORIGIN must be an https origin, got ${origin}`);
    process.exit(1);
  }

  console.log(`[controller] sandboxes will dial ${origin}`);
  console.log(
    "[controller] every session now creates a real Modal sandbox in your workspace and spends real credit",
  );

  // Build the sandbox image here: Modal builds lazily and a build takes
  // minutes, while the driver gives a create twenty seconds.
  const build = spawnSync("uv", ["run", "--frozen", "python", "scripts/build_sandbox_image.py"], {
    cwd: controllerRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error("[controller] the sandbox image did not build; not serving");
    process.exit(build.status ?? 1);
  }

  const uvicorn = spawn("uv", plan.uvicornArgs, {
    cwd: controllerRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ONCUE_CONTROLLER_TOKEN: token,
      ONCUE_CONTROL_PLANE_ORIGIN: origin,
    },
  });
  children.push(uvicorn);
  uvicorn.on("exit", (code) => {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    process.exit(code ?? 0);
  });
}

/**
 * `cloudflared tunnel --url` prints its assigned `*.trycloudflare.com` origin
 * to stderr once the tunnel is up; that line is the only thing read from it.
 */
function openQuickTunnel(tunnelArgs) {
  return new Promise((resolve, reject) => {
    const tunnel = spawn("cloudflared", tunnelArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(tunnel);
    let settled = false;
    const read = (chunk) => {
      // cloudflared names its own API host (`api.trycloudflare.com`) before
      // it announces the tunnel; only the assigned origin is wanted.
      const match = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
      if (match !== null && !settled) {
        settled = true;
        resolve(match[0]);
      }
    };
    tunnel.stdout.on("data", read);
    tunnel.stderr.on("data", (chunk) => {
      read(chunk);
      // cloudflared says why a quick tunnel could not be requested (a rate
      // limit, a network failure) only here.
      for (const line of String(chunk).split("\n")) {
        if (/ERR|WRN/.test(line)) {
          console.error(`[cloudflared] ${line.trim()}`);
        }
      }
    });
    tunnel.on("error", (error) => {
      reject(
        new Error(
          `could not start cloudflared (${error.message}); install it or set ONCUE_CONTROL_PLANE_ORIGIN`,
        ),
      );
    });
    tunnel.on("exit", (code) => {
      if (!settled) {
        reject(new Error(`cloudflared exited with ${code} before announcing a tunnel`));
        return;
      }
      // The origin the sandboxes dial is gone; nothing created after this
      // could reach the control plane, so stop rather than serve.
      console.error(`[controller] cloudflared exited with ${code}; the tunnel is gone`);
      for (const child of children) {
        child.kill("SIGTERM");
      }
      process.exit(1);
    });
  });
}
