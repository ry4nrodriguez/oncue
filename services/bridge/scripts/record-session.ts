/**
 * Records one real OpenCode session into `fixtures/opencode-session-recorded.jsonl`:
 * every server-sent event in order, with marker lines naming each phase (a task
 * end to end, a second prompt mid-turn, an abort of a running shell command, a
 * denied tool). The normalizer is built against this recording.
 *
 * The model key comes from the macOS keychain item named by
 * `ONCUE_LIVE_MODEL_KEY_SERVICE` (default `oncue-recording-anthropic-key`, the
 * same item `pnpm dev:live` reads) and is held by a loopback proxy standing
 * where the bridge's relay stands. OpenCode is configured as the sandbox
 * configures it (the relay's origin plus `/v1` as the Anthropic base URL and a
 * placeholder key), so the key never enters OpenCode's config, environment, or
 * the output; the script refuses to write output that contains it.
 *
 * The output is committed, so everything machine-specific is rewritten before
 * it is written: the scratch, home, and temporary directories (also their
 * resolved `/private/...` forms), the user's name, and every `PATH` value,
 * which becomes a short generic one. Streamed deltas are rewritten on their
 * joined text, because a path split across two chunks survives a per-line
 * replace. The script refuses to write output that still holds any of them.
 *
 * Costs model credit. `ONCUE_RECORD_REPO` names the repository to clone (an
 * https URL `gh auth token` can read) and is required:
 *
 *   ONCUE_RECORD_REPO=https://github.com/<owner>/<repo>.git \
 *     pnpm --filter @oncue/bridge exec tsx scripts/record-session.ts
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? join(userInfo().homedir, ".opencode/bin/opencode");
const REPOSITORY = process.env.ONCUE_RECORD_REPO ?? "";
const MODEL_ID = process.env.ONCUE_RECORD_MODEL ?? "claude-sonnet-5";
const KEYCHAIN_SERVICE =
  process.env.ONCUE_LIVE_MODEL_KEY_SERVICE ?? "oncue-recording-anthropic-key";
// What every recorded `PATH` value becomes; the real one names the recording
// machine's tools and directories.
const GENERIC_PATH = "/usr/local/bin:/usr/bin:/bin";
const OUT_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));
const OPENCODE_PORT = 4717;
const QUIET_MS = 6_000;
const PHASE_TIMEOUT_MS = 8 * 60_000;

const TASK = "Add a README section describing the test command.";

interface Recorded {
  readonly at: string;
  readonly event?: unknown;
  readonly marker?: { readonly phase: string; readonly note: string };
}

interface ProxyLine {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly requestHeaders: readonly string[];
  readonly status: number;
  readonly durationMs: number;
}

function now(): string {
  return new Date().toISOString();
}

function readKey(): string {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.error(
      `record-session: no keychain item '${KEYCHAIN_SERVICE}'. Add it with\n` +
        `  security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
    );
    process.exit(78);
  }
}

function startProxy(key: string, log: ProxyLine[]): Promise<number> {
  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value !== "string") {
          continue;
        }
        if (["host", "authorization", "x-api-key", "content-length", "connection"].includes(name)) {
          continue;
        }
        headers[name] = value;
      }
      headers["x-api-key"] = key;
      const body = Buffer.concat(chunks);
      headers["content-length"] = String(body.length);
      const upstream = httpsRequest(
        { host: "api.anthropic.com", method: req.method, path: req.url, headers },
        (up) => {
          log.push({
            at: now(),
            method: req.method ?? "",
            path: req.url ?? "",
            requestHeaders: Object.keys(req.headers).sort(),
            status: up.statusCode ?? 0,
            durationMs: Date.now() - startedAt,
          });
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502).end();
      });
      upstream.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function cloneRepository(into: string): void {
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const helper = `!f() { echo username=x-access-token; echo "password=${token}"; }; f`;
  execFileSync("git", ["-c", `credential.helper=${helper}`, "clone", "-q", REPOSITORY, into], {
    stdio: "inherit",
  });
}

async function waitForHealth(origin: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/global/health`);
      if (response.ok) {
        const body = (await response.json()) as { version?: string };
        return body.version ?? "unknown";
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("opencode serve did not answer /global/health");
}

async function subscribe(origin: string, recorded: Recorded[]): Promise<() => void> {
  const controller = new AbortController();
  const response = await fetch(`${origin}/event`, { signal: controller.signal });
  if (response.body === null) {
    throw new Error("no event body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data !== "") {
            recorded.push({ at: now(), event: JSON.parse(data) as unknown });
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // aborted at the end of the recording
    }
  })();
  return () => controller.abort();
}

async function post(origin: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  return text === "" ? null : (JSON.parse(text) as unknown);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type Predicate = (event: unknown) => boolean;

async function waitFor(recorded: Recorded[], from: number, predicate: Predicate): Promise<number> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  let cursor = from;
  while (Date.now() < deadline) {
    for (; cursor < recorded.length; cursor += 1) {
      const line = recorded[cursor];
      if (line?.event !== undefined && predicate(line.event)) {
        return cursor + 1;
      }
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for an event");
}

async function waitQuiet(recorded: Recorded[]): Promise<void> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  let lastLength = recorded.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(250);
    if (recorded.length !== lastLength) {
      lastLength = recorded.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= QUIET_MS && sawIdle(recorded)) {
      return;
    }
  }
  throw new Error("session never went quiet");
}

function typeOf(event: unknown): string {
  return typeof event === "object" && event !== null && "type" in event ? String(event.type) : "";
}

function sawIdle(recorded: Recorded[]): boolean {
  for (let index = recorded.length - 1; index >= 0; index -= 1) {
    const type = typeOf(recorded[index]?.event);
    if (type === "session.idle") {
      return true;
    }
    if (type === "session.status") {
      const event = recorded[index]?.event as
        | { properties?: { status?: { type?: string } } }
        | undefined;
      return event?.properties?.status?.type === "idle";
    }
  }
  return false;
}

function runningBash(event: unknown): boolean {
  const text = JSON.stringify(event);
  return (
    (typeOf(event) === "message.part.updated" &&
      text.includes('"tool":"bash"') &&
      text.includes('"status":"running"')) ||
    (typeOf(event) === "session.next.tool.called" && text.includes('"tool":"bash"'))
  );
}

type Replacements = readonly (readonly [string, string])[];

function replaceLiterals(text: string, replacements: Replacements): string {
  let result = text;
  for (const [from, to] of replacements) {
    if (from !== "") {
      result = result.replaceAll(from, to);
    }
  }
  return result;
}

/**
 * A provider's signature over a reasoning block is an opaque base64 blob the
 * literal replacements cannot see into, and it carries identifiers of the
 * account that made the request. Nothing replays it, so it is not kept.
 */
const PROVIDER_SIGNATURE = /(\\*"signature\\*"\s*:\s*\\*")[A-Za-z0-9+/=]{100,}(\\*")/g;

export function scrubSignatures(text: string): string {
  return text.replace(PROVIDER_SIGNATURE, "$1scrubbed-signature$2");
}

function scrub(text: string, replacements: Replacements): string {
  // Raw text ends a value at a newline, JSON text at an escape or a quote.
  return replaceLiterals(text, replacements).replace(/PATH=[^\n"\\]*/g, `PATH=${GENERIC_PATH}`);
}

interface Delta {
  readonly type: "message.part.delta";
  readonly properties: { readonly partID: string; readonly delta: string };
}

function isDelta(event: unknown): event is Delta {
  if (typeOf(event) !== "message.part.delta") {
    return false;
  }
  const properties = (event as { properties?: unknown }).properties;
  return (
    typeof properties === "object" &&
    properties !== null &&
    typeof (properties as { partID?: unknown }).partID === "string" &&
    typeof (properties as { delta?: unknown }).delta === "string"
  );
}

/**
 * Splits `text` into exactly `count` pieces, keeping the leading and trailing
 * `chunks` that already match it so only the rewritten middle is re-split.
 */
function resplit(chunks: readonly string[], text: string): string[] {
  const joined = chunks.join("");
  let head = 0;
  let headLength = 0;
  while (
    head < chunks.length &&
    text.startsWith(joined.slice(0, headLength + (chunks[head]?.length ?? 0)))
  ) {
    headLength += chunks[head]?.length ?? 0;
    head += 1;
  }
  let tail = 0;
  let tailLength = 0;
  while (tail < chunks.length - head) {
    const next = chunks[chunks.length - 1 - tail]?.length ?? 0;
    const suffix = joined.slice(joined.length - tailLength - next);
    if (!text.endsWith(suffix) || text.length - tailLength - next < headLength) {
      break;
    }
    tailLength += next;
    tail += 1;
  }
  const middle = text.slice(headLength, text.length - tailLength);
  const count = chunks.length - head - tail;
  const pieces: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((index * middle.length) / count);
    const end = Math.floor(((index + 1) * middle.length) / count);
    pieces.push(middle.slice(start, end));
  }
  let result = [...chunks.slice(0, head), ...pieces, ...chunks.slice(chunks.length - tail)];
  if (count === 0 && middle !== "") {
    // Every chunk matched as head or tail but the text grew: the new text goes
    // at the boundary between them, never after the tail.
    result =
      head > 0
        ? result.map((chunk, index) => (index === head - 1 ? chunk + middle : chunk))
        : result.map((chunk, index) => (index === 0 ? middle + chunk : chunk));
  }
  if (result.join("") !== text) {
    throw new Error("record-session: re-split chunks do not join to the scrubbed text");
  }
  return result;
}

/**
 * Rewrites every streamed part's deltas so that their joined text is the
 * scrubbed joined text. A value split across chunks ("/Users/na" + "me/...")
 * is invisible to a per-line replace, so the scrub runs on the whole part.
 */
function scrubDeltas(recorded: readonly Recorded[], clean: (text: string) => string): Recorded[] {
  const byPart = new Map<string, { readonly index: number; readonly event: Delta }[]>();
  recorded.forEach((line, index) => {
    if (isDelta(line.event)) {
      const entries = byPart.get(line.event.properties.partID) ?? [];
      entries.push({ index, event: line.event });
      byPart.set(line.event.properties.partID, entries);
    }
  });
  const result = [...recorded];
  for (const entries of byPart.values()) {
    const chunks = entries.map((entry) => entry.event.properties.delta);
    const joined = chunks.join("");
    const cleaned = clean(joined);
    if (cleaned === joined) {
      continue;
    }
    const pieces = resplit(chunks, cleaned);
    entries.forEach(({ index, event }, position) => {
      result[index] = {
        at: recorded[index]?.at ?? now(),
        event: { ...event, properties: { ...event.properties, delta: pieces[position] ?? "" } },
      };
    });
  }
  return result;
}

/** Every streamed part's joined text, for the final leak check. */
function joinedDeltas(recorded: readonly Recorded[]): string {
  const byPart = new Map<string, string>();
  for (const line of recorded) {
    if (isDelta(line.event)) {
      const { partID, delta } = line.event.properties;
      byPart.set(partID, (byPart.get(partID) ?? "") + delta);
    }
  }
  return [...byPart.values()].join("\n");
}

async function main(): Promise<void> {
  if (REPOSITORY === "") {
    console.error(
      "record-session: set ONCUE_RECORD_REPO to the https URL of the repository to clone",
    );
    process.exit(64);
  }
  const key = readKey();
  const proxyLog: ProxyLine[] = [];
  const recorded: Recorded[] = [];
  const proxyPort = await startProxy(key, proxyLog);
  const scratch = mkdtempSync(join(tmpdir(), "oncue-record-"));
  const work = join(scratch, "workspace");
  const home = join(scratch, "home");
  mkdirSync(home);
  cloneRepository(work);

  const configPath = join(scratch, "opencode.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        share: "disabled",
        autoupdate: false,
        snapshot: false,
        model: `anthropic/${MODEL_ID}`,
        provider: {
          anthropic: {
            options: { baseURL: `http://127.0.0.1:${proxyPort}/v1`, apiKey: "oncue-relay" },
          },
        },
        permission: { task: "deny", question: "deny" },
        subagent_depth: 0,
      },
      null,
      2,
    ),
  );

  const origin = `http://127.0.0.1:${OPENCODE_PORT}`;
  const serverLog: string[] = [];
  const server = spawn(
    OPENCODE_BIN,
    [
      "serve",
      "--port",
      String(OPENCODE_PORT),
      "--hostname",
      "127.0.0.1",
      "--log-level",
      "WARN",
      "--print-logs",
    ],
    {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
        OPENCODE_CONFIG: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (chunk: Buffer) => serverLog.push(`stdout ${chunk.toString()}`));
  server.stderr.on("data", (chunk: Buffer) => serverLog.push(`stderr ${chunk.toString()}`));

  const version = await waitForHealth(origin);
  console.log(`opencode ${version} up on ${origin}, proxy on ${proxyPort}`);
  const stop = await subscribe(origin, recorded);
  await sleep(500);

  const mark = (phase: string, note: string): void => {
    recorded.push({ at: now(), marker: { phase, note } });
    console.log(`[${phase}] ${note}`);
  };
  const model = { providerID: "anthropic", modelID: MODEL_ID };
  const prompt = (sessionId: string, text: string): Promise<unknown> =>
    post(origin, `/session/${sessionId}/prompt_async`, { model, parts: [{ type: "text", text }] });

  mark("setup", `opencode ${version}, model ${MODEL_ID}, repository ${REPOSITORY}`);
  const session = (await post(origin, "/session", { title: "oncue recording" })) as { id: string };
  const sessionId = session.id;
  mark("task", `session ${sessionId} created; sending: ${TASK}`);
  await prompt(sessionId, TASK);
  await waitFor(recorded, recorded.length, (event) => typeOf(event) === "session.status");
  await waitQuiet(recorded);
  mark("task", "quiet after the task");

  mark("steer", "sending a 20 second shell command, then a second prompt while it runs");
  const steerFrom = recorded.length;
  await prompt(
    sessionId,
    "Use bash to run `sleep 20`, then tell me the name of the current git branch.",
  );
  await waitFor(recorded, steerFrom, runningBash);
  mark("steer", "bash is running; sending the steering prompt now");
  await prompt(sessionId, "Also mention the lint command from package.json in your reply.");
  await waitQuiet(recorded);
  mark("steer", "quiet after steering");

  mark("cancel", "sending a 90 second shell command, then aborting while it runs");
  const cancelFrom = recorded.length;
  await prompt(sessionId, "Use bash to run `sleep 90`, then say done.");
  await waitFor(recorded, cancelFrom, runningBash);
  await sleep(1_000);
  mark("cancel", "bash is running; POST /session/:id/abort now");
  const aborted = await post(origin, `/session/${sessionId}/abort`, {});
  mark("cancel", `abort answered ${JSON.stringify(aborted)}`);
  await waitQuiet(recorded);
  mark("cancel", "quiet after abort");

  mark("task-denied", "asking for a subagent through the task tool");
  await prompt(
    sessionId,
    "Use the task tool to spawn a subagent that lists the repository's files, then summarize what it found.",
  );
  await waitQuiet(recorded);
  mark("task-denied", "quiet");

  mark("question-denied", "asking the agent to use the question tool");
  await prompt(
    sessionId,
    "Use the question tool to ask me which colour I prefer, then answer with whatever I chose.",
  );
  await waitQuiet(recorded);
  mark("question-denied", "quiet");

  mark("environment", "asking the agent to print its environment");
  await prompt(sessionId, "Run `env | sort` with bash and paste the output verbatim.");
  await waitQuiet(recorded);
  mark("environment", "quiet");

  const messages = await (await fetch(`${origin}/session/${sessionId}/message`)).json();
  const diff = await (await fetch(`${origin}/session/${sessionId}/diff`)).json();
  const gitDiff = execFileSync("git", ["diff"], { cwd: work, encoding: "utf8" });
  const gitStatus = execFileSync("git", ["status", "--short"], { cwd: work, encoding: "utf8" });
  mark("done", `git status:\n${gitStatus}`);

  stop();
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));

  // Longest first, and each directory also in its resolved form: on macOS the
  // temporary directory is a symlink, and OpenCode reports the `/private/...` path.
  const directories: (readonly [string, string])[] = [
    [work, "/workspace"],
    [home, "/home/oncue-agent"],
    [scratch, "/scratch"],
    [tmpdir(), "/tmp"],
    [userInfo().homedir, "/home/oncue-agent"],
  ];
  const replacements: Replacements = [
    [key, "[KEY]"],
    [process.env.PATH ?? "", GENERIC_PATH],
    ...directories.flatMap(([from, to]): (readonly [string, string])[] => [
      [realpathSync(from), to],
      [from, to],
    ]),
    [userInfo().username, "oncue-agent"],
  ];
  const leaks = [
    ...new Set([
      userInfo().homedir,
      realpathSync(userInfo().homedir),
      tmpdir(),
      realpathSync(tmpdir()),
    ]),
  ].filter((path) => !["/", "/tmp", "/home/oncue-agent"].includes(path));
  const cleaned = scrubDeltas(recorded, (text) => scrub(text, replacements));
  // A delta line is already clean on its joined text; the `PATH=` rewrite on
  // one chunk alone would duplicate the value across its neighbours.
  const lines = cleaned
    .map((line) =>
      isDelta(line.event)
        ? replaceLiterals(JSON.stringify(line), replacements)
        : scrub(JSON.stringify(line), replacements),
    )
    .map(scrubSignatures)
    .join("\n");
  const meta = scrubSignatures(
    scrub(
      JSON.stringify(
        {
          recordedAt: now(),
          opencodeVersion: version,
          model: MODEL_ID,
          repository: REPOSITORY,
          sessionId,
          proxy: proxyLog,
          finalMessages: messages,
          sessionDiff: diff,
          gitDiff,
          gitStatus,
          serverLog,
        },
        null,
        2,
      ),
      replacements,
    ),
  );
  const streamed = joinedDeltas(cleaned);
  for (const needle of [key, "sk-ant", "ghp_", "Bearer ", ...leaks]) {
    if (lines.includes(needle) || meta.includes(needle) || streamed.includes(needle)) {
      rmSync(scratch, { recursive: true, force: true });
      throw new Error(
        `refusing to write: output contains ${needle === key ? "the key" : leaks.includes(needle) ? "a local path" : needle}`,
      );
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "opencode-session-recorded.jsonl"), `${lines}\n`);
  writeFileSync(join(OUT_DIR, "opencode-session-recorded.meta.json"), `${meta}\n`);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`wrote ${recorded.length} lines to ${OUT_DIR}`);
  const kinds = new Map<string, number>();
  for (const line of recorded) {
    if (line.event !== undefined) {
      const type = typeOf(line.event);
      kinds.set(type, (kinds.get(type) ?? 0) + 1);
    }
  }
  console.log([...kinds.entries()].map(([type, count]) => `${count}\t${type}`).join("\n"));
  console.log(
    `proxy saw ${proxyLog.length} requests: ${[...new Set(proxyLog.map((l) => `${l.method} ${l.path}`))].join(", ")}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
