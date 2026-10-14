# @oncue/protocol

The wire protocol between the sandbox bridge, the session Durable Object, and the browser: the event envelope, the event types record 04 names (`pnpm check-records` holds the list and the code to the same count), the ten commands, the state machines, admission, redaction, and the fold that turns a committed event stream into what the interface renders.

## Rules

- Adding an event type is one edit: one entry in the family file under `src/families/`. The `EventType` union, the payload map, the envelope's nullability rules, the builders, and `check-records` all derive from that entry. If the type is missing from `PAYLOAD_DEFAULTS` in `src/testing/defaults.ts`, that is a compile error, not a silent gap.
- Only `src/schema.ts` imports valibot. Every other module imports the named subset it re-exports, so swapping the validator is a one-file change.
- The architecture records are the source of truth. `check-records` fails when `states.ts` or the catalog disagrees with the fenced transition blocks in records 01, 11, and 12 or the family lists in record 04.

## Scripts

```sh
pnpm --filter @oncue/protocol check-records   # records 01, 04, 11, 12 against states.ts and the catalog
pnpm --filter @oncue/protocol fixtures:write  # regenerate fixtures/*.jsonl from builder code
pnpm --filter @oncue/protocol check-fixtures  # every fixture line through the parser and admission
pnpm --filter @oncue/protocol bench           # envelope parses per second; fails below 50,000
```

`fixtures/*.jsonl` are generated, not hand-written. Each line is one wire envelope. A line with a `runtimeSequence` is treated as arriving from the sandbox connection; a line with `null` is treated as minted by the control plane. A fixture named after a rejection reason, such as `stale-generation.jsonl`, must be rejected with exactly that reason and `check-fixtures` reports it as a pass.

`fixtures:write` removes any `.jsonl` it no longer generates, except `opencode-session-recorded.jsonl`, a reserved name. The real OpenCode recording lives in the bridge as `services/bridge/fixtures/opencode-session-recorded.jsonl`, because it is raw OpenCode output the bridge's normalizer replays, not a stream of protocol envelopes.

## Test builders

`@oncue/protocol/testing` exports `makeEvent`, `makeCommand`, `makeCommittedEvent`, `makeRedactedEvent`, and `createStream`. Every builder runs its output through the real parser, so a schema change breaks tests loudly instead of producing invalid fixtures.
