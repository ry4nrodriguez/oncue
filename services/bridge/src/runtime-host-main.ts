// The runtime host's entry point (`dist/runtime-host.mjs`): wires Node's spawn,
// server, and signals to `runtime-host.ts` and exits with the harness's code.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { parseRuntimeHostArgs, startRuntimeHost } from "./runtime-host";

const args = parseRuntimeHostArgs(process.argv.slice(2));
if (args === null) {
  process.stderr.write("usage: runtime-host.mjs --port N -- <binary> [args...]\n");
  process.exit(64);
}
const host = startRuntimeHost(args, {
  spawn: (command, argv, options) => spawn(command, [...argv], options),
  createServer: (onConnection) => createServer(onConnection),
  log: (line) => process.stderr.write(`${line}\n`),
  setTimer: (run, ms) => {
    setTimeout(run, ms).unref();
  },
});
process.on("SIGTERM", () => host.signal("SIGTERM"));
process.on("SIGINT", () => host.signal("SIGINT"));
process.exit(await host.exited);
