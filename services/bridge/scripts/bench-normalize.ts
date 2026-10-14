/**
 * Replays an OpenCode session fixture through the wire parser and the normalizer
 * and prints events per second against the floor of 10,000 (record 23).
 *
 * Usage: pnpm --filter @oncue/bridge bench [path/to/fixture.jsonl]
 *
 * With no argument it uses `fixtures/opencode-session-recorded.jsonl` when it
 * exists, else the hand-written sample. Drafts are validated through the
 * protocol parser on the first replay only, so the timed loop measures the
 * normalizer and the wire parser, not the schema.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEventJson } from "@oncue/protocol";
import {
  advance,
  emptyNormalizerState,
  type NormalizeContext,
  type NormalizerState,
} from "../src/normalize";
import { parseServerEvent } from "../src/opencode-wire";
import { bridgeConfig, type Draft, type SequenceCursor, stampDraft } from "../src/protocol";

// Fail when fixture replay is slower than 10,000 events per second (record 23).
const FLOOR_EVENTS_PER_SECOND = 10_000;
const MIN_MEASURED_MS = 2_000;

const RECORDED_PATH = fileURLToPath(
  new URL("../fixtures/opencode-session-recorded.jsonl", import.meta.url),
);
const SAMPLE_PATH = fileURLToPath(
  new URL("../fixtures/samples/opencode-session-sample.jsonl", import.meta.url),
);

function resolveFixturePath(argPath: string | undefined): { path: string; source: string } {
  if (argPath !== undefined) {
    return { path: argPath, source: "argument" };
  }
  if (existsSync(RECORDED_PATH)) {
    return { path: RECORDED_PATH, source: "recorded fixture" };
  }
  return { path: SAMPLE_PATH, source: "hand-written sample fixture" };
}

/** Non-marker `event` payloads, in file order. Marker lines are skipped. */
function loadEvents(path: string): readonly unknown[] {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly event?: unknown; readonly marker?: unknown });
  const events: unknown[] = [];
  for (const line of lines) {
    if (line.event !== undefined) {
      events.push(line.event);
    }
  }
  return events;
}

function freshContext(): NormalizeContext {
  let issued = 0;
  return {
    nowMs: 10_000,
    newId: () => `bench_id_${++issued}`,
    runId: "bench_run",
    contextWindow: 200_000,
  };
}

const CONFIG = bridgeConfig(
  { sessionId: "bench_sess", generation: 1, bootstrapCredential: "bench" },
  "wss://bench.example",
);

/** Stamps and parses every draft through the real protocol parser. Throws on the first invalid draft. */
function validateDrafts(drafts: readonly Draft[]): number {
  const cursor: SequenceCursor = { next: 0 };
  let issued = 0;
  const io = { newEventId: () => `bench_evt_${++issued}`, now: () => "2026-09-11T00:00:00.000Z" };
  let validated = 0;
  for (const draft of drafts) {
    const event = stampDraft(CONFIG, cursor, io, draft);
    const parsed = parseEventJson(JSON.stringify(event), "sandbox");
    if (!parsed.ok) {
      throw new Error(`bench-normalize: ${draft.type} failed to validate: ${parsed.detail}`);
    }
    validated += 1;
  }
  return validated;
}

/** One full pass over the fixture: wire-parse and normalize every event, in order. */
function replayOnce(rawEvents: readonly unknown[], validate: boolean): number {
  let state: NormalizerState = emptyNormalizerState;
  const ctx = freshContext();
  let validatedCount = 0;
  for (const raw of rawEvents) {
    const event = parseServerEvent(raw);
    const result = advance(state, event, ctx);
    state = result.state;
    if (validate) {
      validatedCount += validateDrafts(result.drafts);
    }
  }
  return validatedCount;
}

function main(): void {
  const { path, source } = resolveFixturePath(process.argv[2]);
  const rawEvents = loadEvents(path);
  if (rawEvents.length === 0) {
    console.error(`bench-normalize: ${path} has no event lines to replay`);
    process.exit(1);
  }

  console.log(`bench-normalize: fixture ${path} (${source})`);
  console.log(`bench-normalize: lines ${rawEvents.length}`);

  // First replay: validate every draft through the real protocol parser, and
  // warm the JIT before the timed loop.
  const validatedDrafts = replayOnce(rawEvents, true);
  console.log(`bench-normalize: validated drafts ${validatedDrafts}`);

  // Replay until the timed loop has run for at least MIN_MEASURED_MS, so the
  // throughput figure is not dominated by JIT warmup or timer resolution.
  let replays = 0;
  const start = performance.now();
  let elapsedMs = 0;
  do {
    replayOnce(rawEvents, false);
    replays += 1;
    elapsedMs = performance.now() - start;
  } while (elapsedMs < MIN_MEASURED_MS);

  const totalEvents = rawEvents.length * replays;
  const eventsPerSecond = totalEvents / (elapsedMs / 1000);

  console.log(`bench-normalize: replays ${replays}`);
  console.log(`bench-normalize: total events ${totalEvents}`);
  console.log(
    `bench-normalize: ${Math.round(eventsPerSecond).toLocaleString("en-US")} events/s over ${elapsedMs.toFixed(1)} ms`,
  );

  if (eventsPerSecond < FLOOR_EVENTS_PER_SECOND) {
    console.error(
      `bench-normalize: FAIL ${Math.round(eventsPerSecond).toLocaleString("en-US")} events/s is below the floor of ${FLOOR_EVENTS_PER_SECOND.toLocaleString("en-US")} events/s`,
    );
    process.exit(1);
  }
  console.log(
    `bench-normalize: PASS floor ${FLOOR_EVENTS_PER_SECOND.toLocaleString("en-US")} events/s`,
  );
}

main();
