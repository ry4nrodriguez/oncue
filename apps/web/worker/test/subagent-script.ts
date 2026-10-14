// The provider double's `subagents` mode: a scripted model that makes a real
// OpenCode start subagents (record 12). It decides from the conversation's own
// words, as a model would, and never from anything OnCue's code computed.
//
// The task names what each subagent does: "[agents:ok,fail,slow]" starts three
// in one message. Each subagent's prompt starts "[subagent:<n>:<behaviour>]":
// `ok` lists the work tree and reports, `fail` gets a provider error, and `slow`
// runs `sleep 120`, so a lane can stop it.

export type SubagentBehaviour = "ok" | "fail" | "slow";

const BEHAVIOURS: ReadonlySet<string> = new Set(["ok", "fail", "slow"]);

interface MessagesBody {
  readonly tools?: ReadonlyArray<{ readonly name?: string }>;
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
}

/** The answer the double owes one request in this mode. */
export type SubagentReply =
  /** Not a turn this mode scripts: the double's ordinary streamed text. */
  | { readonly kind: "text" }
  | { readonly kind: "text_with"; readonly text: string }
  | {
      readonly kind: "calls";
      readonly calls: ReadonlyArray<{
        readonly name: string;
        readonly input: Record<string, unknown>;
      }>;
    }
  | { readonly kind: "fail" };

function firstUserText(body: MessagesBody): string {
  const first = (body.messages ?? []).find((message) => message.role === "user");
  return JSON.stringify(first?.content ?? "");
}

function newestCarriesResult(body: MessagesBody): boolean {
  return JSON.stringify((body.messages ?? []).at(-1) ?? null).includes('"tool_result"');
}

/** The behaviours a task asks for, or null when it asks for no subagents. */
export function behavioursIn(text: string): readonly SubagentBehaviour[] | null {
  const match = /\[agents:([a-z,]+)\]/.exec(text);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const behaviours = match[1].split(",").filter((entry) => BEHAVIOURS.has(entry));
  return behaviours.length === 0 ? null : (behaviours as SubagentBehaviour[]);
}

export const SUBAGENT_DESCRIPTION = (index: number, behaviour: SubagentBehaviour) =>
  `Subagent ${index} (${behaviour})`;

export function subagentReply(rawBody: string): SubagentReply {
  let body: MessagesBody;
  try {
    body = JSON.parse(rawBody) as MessagesBody;
  } catch {
    return { kind: "text" };
  }
  const tools = (body.tools ?? []).map((tool) => tool.name ?? "");
  const first = firstUserText(body);
  const done = newestCarriesResult(body);
  const child = /\[subagent:(\d+):([a-z]+)\]/.exec(first);
  if (child !== null) {
    const behaviour = child[2] as SubagentBehaviour;
    if (behaviour === "fail") {
      return { kind: "fail" };
    }
    if (done || !tools.includes("bash")) {
      return { kind: "text_with", text: `Subagent ${child[1]} looked and found the README.` };
    }
    return {
      kind: "calls",
      calls: [
        {
          name: "bash",
          input:
            behaviour === "slow"
              ? { command: "sleep 120", description: "Wait a while" }
              : { command: "ls", description: "List the work tree" },
        },
      ],
    };
  }
  const behaviours = behavioursIn(first);
  if (behaviours === null || !tools.includes("task")) {
    return { kind: "text" };
  }
  if (done) {
    return { kind: "text_with", text: "The subagents reported back." };
  }
  return {
    kind: "calls",
    calls: behaviours.map((behaviour, index) => ({
      name: "task",
      input: {
        description: SUBAGENT_DESCRIPTION(index + 1, behaviour),
        prompt: `[subagent:${index + 1}:${behaviour}] Look at the work tree and report what you find.`,
        subagent_type: index % 2 === 0 ? "general" : "explore",
      },
    })),
  };
}
