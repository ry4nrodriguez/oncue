import { EVENT_TYPES } from "../src/catalog";
import { type ParseSource, parseEvent, parseEventJson } from "../src/events";
import { makeEvent } from "../src/testing";

// Below 50,000 envelopes per second, validation would exceed 2 percent of a
// 1 millisecond commit budget.
const FLOOR_PER_SECOND = 50_000;
const WARMUP = 20_000;
const MEASURED = 100_000;

type Sample = {
  readonly object: unknown;
  readonly json: string;
  readonly source: ParseSource;
};

const samples: readonly Sample[] = EVENT_TYPES.map((type) => {
  const event = makeEvent(type);
  const json = JSON.stringify(event);
  return {
    object: JSON.parse(json),
    json,
    source: event.runtimeSequence === null ? "control" : "sandbox",
  };
});

function run(label: string, parse: (sample: Sample) => boolean): number {
  for (let i = 0; i < WARMUP; i += 1) {
    const sample = samples[i % samples.length];
    if (sample === undefined || !parse(sample)) {
      throw new Error(`${label}: a sample failed to parse during warmup`);
    }
  }
  let failures = 0;
  const start = performance.now();
  for (let i = 0; i < MEASURED; i += 1) {
    const sample = samples[i % samples.length];
    if (sample === undefined || !parse(sample)) {
      failures += 1;
    }
  }
  const elapsedMs = performance.now() - start;
  if (failures > 0) {
    throw new Error(`${label}: ${failures} of ${MEASURED} parses failed`);
  }
  const perSecond = Math.round(MEASURED / (elapsedMs / 1000));
  console.log(
    `bench: ${label} ${perSecond.toLocaleString("en-US")} envelopes/s (${MEASURED} envelopes over ${samples.length} event types, ${elapsedMs.toFixed(1)} ms, ${WARMUP} warmup)`,
  );
  return perSecond;
}

const schemaRate = run("parseEvent", (sample) => parseEvent(sample.object, sample.source).ok);
run("parseEventJson", (sample) => parseEventJson(sample.json, sample.source).ok);

if (schemaRate < FLOOR_PER_SECOND) {
  console.error(
    `bench: parseEvent ${schemaRate} envelopes/s is below the floor of ${FLOOR_PER_SECOND}`,
  );
  process.exit(1);
}
console.log(`bench: floor ${FLOOR_PER_SECOND.toLocaleString("en-US")} envelopes/s: pass`);
