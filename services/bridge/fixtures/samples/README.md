# Hand-written OpenCode samples

`opencode-session-sample.jsonl` is a HAND-WRITTEN stand-in in the same line
format as the recording `scripts/record-session.ts` produces (`{ at, event }`
and `{ at, marker }`). The real recording, `../opencode-session-recorded.jsonl`,
is what `normalize.test.ts` replays and what the benchmark measures; this file
stays only for the paths the recorded session never exercised: `todo.updated`
(the model wrote no plan for the README task), a tool part with
`status: "error"` (no call failed in the recording), and a kind nobody has seen
(`mystery.kind`).

Its shapes follow the recording where the two overlap: text opens as a
`message.part.updated` with empty text, streams as `message.part.delta` lines
with `field: "text"`, and closes as a `message.part.updated` carrying the whole
text. `message.part.updated` never carries a `delta`; OpenCode 1.18.30 does not
send one.
