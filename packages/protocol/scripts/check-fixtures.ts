import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Admission, admitEvent, advanceCursor, type SessionExpectations } from "../src/admit";
import { PROTOCOL_VERSION } from "../src/envelope";
import { type ParseSource, parseEventJson } from "../src/events";
import type { ParseFailureReason } from "../src/schema";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

type RejectionReason = ParseFailureReason | Exclude<Admission, { kind: "accept" }>["kind"];

// Total over both rejection unions, so a new reason must be named here before
// a fixture can claim it.
const REJECTION_REASONS: { readonly [R in RejectionReason]: true } = {
  malformed_json: true,
  too_large: true,
  envelope: true,
  unsupported_version: true,
  unknown_type: true,
  wrong_origin: true,
  missing_run_id: true,
  unexpected_run_id: true,
  missing_runtime_sequence: true,
  unexpected_runtime_sequence: true,
  ephemeral: true,
  payload: true,
  wrong_session: true,
  stale_generation: true,
  duplicate_event: true,
  sequence_gap: true,
};

function isRejectionReason(value: string): value is RejectionReason {
  return Object.hasOwn(REJECTION_REASONS, value);
}

// `stale-generation.jsonl` is the fixture that must be rejected as
// `stale_generation`. Any other name is a stream that must be accepted whole.
function expectedRejection(file: string): RejectionReason | null {
  const name = file.replace(/\.jsonl$/, "").replaceAll("-", "_");
  return isRejectionReason(name) ? name : null;
}

// A runtime sequence is assigned only by the bridge, so a line carrying one
// arrived on the sandbox connection and a line without one was minted by the
// control plane. That is how a fixture says which connection it came in on.
function inferSource(line: string): ParseSource {
  try {
    const decoded: unknown = JSON.parse(line);
    if (typeof decoded === "object" && decoded !== null && "runtimeSequence" in decoded) {
      return decoded.runtimeSequence === null ? "control" : "sandbox";
    }
  } catch {
    return "sandbox";
  }
  return "sandbox";
}

function describeAdmission(admission: Exclude<Admission, { kind: "accept" }>): string {
  const { kind, ...rest } = admission;
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return detail === "" ? kind : `${kind} (${detail})`;
}

function fail(message: string): never {
  console.error(`check-fixtures: ${message}`);
  process.exit(1);
}

type Outcome = { readonly accepted: number; readonly rejectedAt: number | null };

function checkFixture(file: string): Outcome {
  const expected = expectedRejection(file);
  const text = readFileSync(`${FIXTURES}${file}`, "utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    fail(`${file}: empty fixture`);
  }

  let expectations: SessionExpectations | null = null;
  const knownEventIds = new Set<string>();
  let accepted = 0;
  let firstRejection: number | null = null;

  const reject = (lineNumber: number, reason: RejectionReason, detail: string): void => {
    if (expected === null) {
      fail(`${file}:${lineNumber}: rejected as ${reason}: ${detail}`);
    }
    if (reason !== expected) {
      fail(`${file}:${lineNumber}: expected ${expected}, rejected as ${reason}: ${detail}`);
    }
    firstRejection ??= lineNumber;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      fail(`${file}:${lineNumber}: blank line`);
    }
    const parsed = parseEventJson(line, inferSource(line));
    if (!parsed.ok) {
      reject(lineNumber, parsed.reason, parsed.detail);
      return;
    }
    const event = parsed.value;
    expectations ??= {
      sessionId: event.sessionId,
      sandboxGeneration: event.sandboxGeneration,
      lastRuntimeSequence: null,
      protocolVersion: PROTOCOL_VERSION,
      knownEventIds,
    };
    // The control plane announces each new sandbox by minting the first event
    // of the next generation (record 11), so that event moves the cursor.
    if (
      event.type === "sandbox.provisioning" &&
      event.runtimeSequence === null &&
      event.sandboxGeneration === expectations.sandboxGeneration + 1
    ) {
      expectations = {
        ...expectations,
        sandboxGeneration: event.sandboxGeneration,
        lastRuntimeSequence: null,
      };
    }
    const admission = admitEvent(event, expectations);
    if (admission.kind !== "accept") {
      reject(lineNumber, admission.kind, describeAdmission(admission));
      return;
    }
    knownEventIds.add(event.eventId);
    expectations = { ...expectations, ...advanceCursor(expectations, event) };
    accepted += 1;
  });

  if (expected !== null && firstRejection === null) {
    fail(`${file}: named as a ${expected} case but every line was accepted`);
  }
  return { accepted, rejectedAt: firstRejection };
}

if (!existsSync(FIXTURES)) {
  fail(`no fixtures directory at ${FIXTURES}`);
}
const files = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".jsonl"))
  .sort();
if (files.length === 0) {
  fail("no .jsonl fixtures found; run fixtures:write first");
}

for (const file of files) {
  const outcome = checkFixture(file);
  const expected = expectedRejection(file);
  if (expected === null) {
    console.log(`fixtures/${file}: ${outcome.accepted} events ok`);
  } else {
    console.log(
      `fixtures/${file}: rejected as expected (${expected} at line ${outcome.rejectedAt}, ${outcome.accepted} other events accepted)`,
    );
  }
}
console.log(`${files.length} fixtures ok`);
