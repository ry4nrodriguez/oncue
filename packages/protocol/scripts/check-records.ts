import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES, eventTypesIn } from "../src/catalog";
import { COMMAND_TYPES } from "../src/commands";
import { EVENT_FAMILIES, EVENT_FAMILY_HEADINGS, type EventFamily } from "../src/define";
import {
  type MachineName,
  PLAN_TRANSITIONS,
  RUN_TRANSITIONS,
  SANDBOX_TRANSITIONS,
  type Transitions,
} from "../src/states";

const RECORDS = fileURLToPath(new URL("../../../docs/architecture/", import.meta.url));

type MachineRecord = {
  readonly machine: MachineName;
  readonly file: string;
  readonly transitions: Transitions<string>;
};

const MACHINE_RECORDS: readonly MachineRecord[] = [
  { machine: "run", file: "01-control-plane.md", transitions: RUN_TRANSITIONS },
  {
    machine: "sandbox",
    file: "11-sandbox-lifecycle-and-caching.md",
    transitions: SANDBOX_TRANSITIONS,
  },
  { machine: "plan", file: "12-primary-agent-and-planning.md", transitions: PLAN_TRANSITIONS },
];

const EVENT_RECORD = "04-agent-runtime-and-event-protocol.md";
const FAMILIES_HEADING = "## Initial event families";
const COMMANDS_HEADING = "## Commands sent to the runtime";

const problems: string[] = [];

function problem(message: string): void {
  problems.push(message);
}

function readRecord(file: string): string {
  return readFileSync(`${RECORDS}${file}`, "utf8");
}

function fencedBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    if (current !== null) {
      current.push(line);
    }
  }
  return blocks;
}

const EDGE = /^([a-z_]+) -> ([a-z_]+)$/;

// The one fenced block in a record whose every line is `from -> to`.
function transitionBlock(file: string): string[] | null {
  const candidates = fencedBlocks(readRecord(file)).filter((block) => {
    const lines = block.filter((line) => line.trim() !== "");
    return lines.length > 0 && lines.every((line) => EDGE.test(line));
  });
  const first = candidates[0];
  if (first === undefined) {
    problem(`${file}: no fenced block of "from -> to" lines`);
    return null;
  }
  if (candidates.length > 1) {
    problem(`${file}: ${candidates.length} fenced transition blocks, expected exactly one`);
    return null;
  }
  return first.filter((line) => line.trim() !== "");
}

function edgesOf(transitions: Transitions<string>): Set<string> {
  const edges = new Set<string>();
  for (const [from, targets] of Object.entries(transitions)) {
    for (const to of targets) {
      edges.add(`${from} -> ${to}`);
    }
  }
  return edges;
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort();
}

function checkMachine(record: MachineRecord): void {
  const lines = transitionBlock(record.file);
  if (lines === null) {
    return;
  }
  const recorded = new Set<string>();
  const recordedStates = new Set<string>();
  for (const line of lines) {
    const match = EDGE.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      problem(`${record.file}: unreadable transition line "${line}"`);
      continue;
    }
    if (recorded.has(line)) {
      problem(`${record.file}: transition listed twice: ${line}`);
    }
    recorded.add(line);
    recordedStates.add(match[1]);
    recordedStates.add(match[2]);
  }
  const coded = edgesOf(record.transitions);
  const codedStates = new Set(Object.keys(record.transitions));
  for (const edge of difference(recorded, coded)) {
    problem(`${record.machine}: in ${record.file}, not in states.ts: ${edge}`);
  }
  for (const edge of difference(coded, recorded)) {
    problem(`${record.machine}: in states.ts, not in ${record.file}: ${edge}`);
  }
  for (const state of difference(recordedStates, codedStates)) {
    problem(`${record.machine}: state named in ${record.file}, missing from states.ts: ${state}`);
  }
  for (const state of difference(codedStates, recordedStates)) {
    problem(`${record.machine}: state in states.ts never appears in ${record.file}: ${state}`);
  }
}

type RecordedFamilies = ReadonlyMap<string, readonly string[]>;

function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) {
    problem(`${EVENT_RECORD}: heading not found: ${heading}`);
    return [];
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    body.push(line);
  }
  return body;
}

const BULLET = /^- `([a-z_.]+)`$/;

function recordedFamilies(markdown: string): RecordedFamilies {
  const families = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of section(markdown, FAMILIES_HEADING)) {
    if (line.startsWith("### ")) {
      const heading = line.slice(4).trim();
      if (families.has(heading)) {
        problem(`${EVENT_RECORD}: family heading listed twice: ${heading}`);
      }
      current = [];
      families.set(heading, current);
      continue;
    }
    const match = BULLET.exec(line);
    if (match === null || match[1] === undefined) {
      continue;
    }
    if (current === null) {
      problem(`${EVENT_RECORD}: event bullet before any family heading: ${match[1]}`);
      continue;
    }
    current.push(match[1]);
  }
  return families;
}

function recordedCommands(markdown: string): string[] {
  const commands: string[] = [];
  for (const line of section(markdown, COMMANDS_HEADING)) {
    const match = BULLET.exec(line);
    if (match !== null && match[1] !== undefined) {
      commands.push(match[1]);
    }
  }
  return commands;
}

function checkEvents(): void {
  const markdown = readRecord(EVENT_RECORD);
  const recorded = recordedFamilies(markdown);
  const headingToFamily = new Map<string, EventFamily>();
  for (const family of EVENT_FAMILIES) {
    headingToFamily.set(EVENT_FAMILY_HEADINGS[family], family);
  }
  for (const heading of recorded.keys()) {
    if (!headingToFamily.has(heading)) {
      problem(`events: family heading in ${EVENT_RECORD}, not in define.ts: ${heading}`);
    }
  }
  for (const [heading, family] of headingToFamily) {
    if (!recorded.has(heading)) {
      problem(`events: family in define.ts, not in ${EVENT_RECORD}: ${family} ("${heading}")`);
    }
  }

  const recordedTypes = new Set<string>();
  for (const [heading, types] of recorded) {
    const family = headingToFamily.get(heading);
    for (const type of types) {
      if (recordedTypes.has(type)) {
        problem(`events: ${EVENT_RECORD} lists ${type} twice`);
      }
      recordedTypes.add(type);
    }
    if (family === undefined) {
      continue;
    }
    const coded = new Set<string>(eventTypesIn(family));
    for (const type of difference(new Set(types), coded)) {
      problem(`events: ${type} is under "${heading}" in ${EVENT_RECORD}, not in the catalog`);
    }
    for (const type of difference(coded, new Set(types))) {
      problem(
        `events: ${type} is in the catalog as ${family}, not under "${heading}" in ${EVENT_RECORD}`,
      );
    }
  }
  const codedTypes = new Set<string>(EVENT_TYPES);
  for (const type of difference(recordedTypes, codedTypes)) {
    problem(`events: in ${EVENT_RECORD}, not in the catalog: ${type}`);
  }
  for (const type of difference(codedTypes, recordedTypes)) {
    problem(`events: in the catalog, not in ${EVENT_RECORD}: ${type}`);
  }

  const commands = recordedCommands(markdown);
  const codedCommands = new Set<string>(COMMAND_TYPES);
  for (const command of difference(new Set(commands), codedCommands)) {
    problem(`commands: in ${EVENT_RECORD}, not in commands.ts: ${command}`);
  }
  for (const command of difference(codedCommands, new Set(commands))) {
    problem(`commands: in commands.ts, not in ${EVENT_RECORD}: ${command}`);
  }
}

for (const record of MACHINE_RECORDS) {
  checkMachine(record);
}
checkEvents();

if (problems.length > 0) {
  console.error(
    `check-records: ${problems.length} disagreement(s) between the records and the code`,
  );
  for (const line of problems) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}

console.log(
  `check-records: records agree with the code. ${MACHINE_RECORDS.length} state machines, ${EVENT_FAMILIES.length} event families, ${EVENT_TYPES.length} event types, ${COMMAND_TYPES.length} commands.`,
);
