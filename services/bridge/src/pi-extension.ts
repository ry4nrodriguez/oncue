/**
 * OnCue's Pi extension, which Pi loads as the agent user. It holds nothing the
 * agent could not read: two loopback ports, a model, the tool list, and the
 * relay's placeholder in place of a key. It registers the model as a provider
 * whose base URL is the relay, registers OnCue's tools as forwards to the
 * bridge's loopback tool server, and holds `secret_request` until the bridge
 * answers; anything but an explicit `once` blocks the call. Its question tool
 * opens a dialog the bridge shows as the user's card, and returns the answer.
 *
 * It imports none of Pi's packages: the types below are the parts of Pi
 * 0.87.1's `ExtensionAPI` it uses, and `Type.Unsafe` is passed in by the entry.
 * Not yet run inside Pi.
 */

/** The document `pi.ts`'s `piConfig` writes. Validated here, since Pi hands it over as an environment string. */
export interface PiOnCueDocument {
  readonly provider: {
    readonly id: string;
    readonly api: string;
    readonly baseUrl: string;
    readonly apiKey: string;
  };
  readonly model: {
    readonly id: string;
    readonly name: string;
    readonly reasoning: boolean;
    readonly input: readonly string[];
    readonly contextWindow: number;
    readonly maxTokens: number;
  };
  readonly toolUrl: string;
  readonly toolPrefix: string;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }[];
  readonly held: readonly string[];
  readonly holdTitle: string;
  /** Absent in a document written before the question tool existed. */
  readonly question: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly title: string;
  } | null;
}

/** Pi's `AgentToolResult`, as much of it as a forwarded tool fills in. */
export interface PiToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: undefined;
}

export interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate?: unknown,
    ctx?: PiToolCallContext,
  ): Promise<PiToolResult>;
}

export interface PiToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface PiToolCallContext {
  readonly hasUI: boolean;
  readonly ui: {
    input(
      title: string,
      placeholder?: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<string | undefined>;
  };
}

export type PiToolCallResult = { readonly block: true; readonly reason: string } | undefined;

/** The parts of Pi's `ExtensionAPI` this extension calls. */
export interface PiExtensionApi {
  registerProvider(name: string, config: Readonly<Record<string, unknown>>): void;
  registerTool(tool: PiToolDefinition): void;
  on(
    event: "tool_call",
    handler: (event: PiToolCallEvent, ctx: PiToolCallContext) => Promise<PiToolCallResult>,
  ): void;
}

export interface PiExtensionDeps {
  /** The document, from `PI_ONCUE_CONFIG`. */
  readonly config: string | undefined;
  /** TypeBox's `Type.Unsafe`: a JSON Schema as the schema type Pi's tools take. */
  readonly schema: (jsonSchema: unknown) => unknown;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** The document, or null when it is missing or not one `piConfig` wrote. */
export function parsePiOnCueDocument(raw: string | undefined): PiOnCueDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    return null;
  }
  const doc = asRecord(parsed);
  const provider = asRecord(doc?.provider);
  const model = asRecord(doc?.model);
  if (
    doc === null ||
    doc.version !== 1 ||
    provider === null ||
    model === null ||
    !isString(provider.id) ||
    !isString(provider.api) ||
    !isString(provider.baseUrl) ||
    !isString(provider.apiKey) ||
    !isString(model.id) ||
    !isString(model.name) ||
    typeof model.reasoning !== "boolean" ||
    !Array.isArray(model.input) ||
    typeof model.contextWindow !== "number" ||
    typeof model.maxTokens !== "number" ||
    !isString(doc.toolUrl) ||
    typeof doc.toolPrefix !== "string" ||
    !Array.isArray(doc.tools) ||
    !Array.isArray(doc.held) ||
    !isString(doc.holdTitle)
  ) {
    return null;
  }
  const question = asRecord(doc.question);
  const tools = doc.tools.flatMap((raw) => {
    const tool = asRecord(raw);
    return tool !== null && isString(tool.name) && typeof tool.description === "string"
      ? [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }]
      : [];
  });
  return {
    provider: {
      id: provider.id,
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    },
    model: {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input.filter((entry): entry is string => typeof entry === "string"),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    },
    toolUrl: doc.toolUrl,
    toolPrefix: doc.toolPrefix,
    tools,
    held: doc.held.filter(isString),
    holdTitle: doc.holdTitle,
    question:
      question !== null &&
      isString(question.name) &&
      typeof question.description === "string" &&
      isString(question.title)
        ? {
            name: question.name,
            description: question.description,
            inputSchema: question.inputSchema,
            title: question.title,
          }
        : null,
  };
}

/** What the bridge answers the question dialog with (`pi-client.ts`'s `PiQuestionAnswer`). */
export function questionResult(answer: string | undefined): PiToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer ?? "");
  } catch {
    throw new Error("Nobody answered the question.");
  }
  const decision = asRecord(parsed);
  const text = typeof decision?.text === "string" ? decision.text : "";
  if (decision?.answered !== true) {
    throw new Error(text || "The user dismissed the question.");
  }
  return { content: [{ type: "text", text }], details: undefined };
}

/** One text answer from the tool server, and whether it is an error in the tool's own terms. */
export interface ForwardedAnswer {
  readonly text: string;
  readonly isError: boolean;
}

/** One `tools/call` to the bridge's tool server. Never throws: a failure is an error answer. */
export async function forwardToolCall(
  deps: Pick<PiExtensionDeps, "fetch">,
  toolUrl: string,
  name: string,
  args: unknown,
  signal: AbortSignal | undefined,
): Promise<ForwardedAnswer> {
  try {
    const response = await deps.fetch(toolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const body = asRecord(await response.json());
    const error = asRecord(body?.error);
    if (error !== null) {
      return {
        text: typeof error.message === "string" ? error.message : "The tool failed.",
        isError: true,
      };
    }
    const result = asRecord(body?.result);
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .flatMap((block) => {
        const item = asRecord(block);
        return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("\n");
    return { text, isError: result?.isError === true };
  } catch {
    return { text: "The tool failed: the bridge's tool server did not answer.", isError: true };
  }
}

/** The bridge's answer to a held call (`pi-client.ts`'s `PiHoldAnswer`); anything else blocks. */
export function holdDecision(answer: string | undefined): PiToolCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer ?? "");
  } catch {
    return { block: true, reason: "Nobody answered this request." };
  }
  const decision = asRecord(parsed);
  if (decision?.reply === "once") {
    return undefined;
  }
  return {
    block: true,
    reason:
      typeof decision?.message === "string" && decision.message !== ""
        ? decision.message
        : "The user did not allow this.",
  };
}

export function installOnCueExtension(pi: PiExtensionApi, deps: PiExtensionDeps): void {
  const doc = parsePiOnCueDocument(deps.config);
  if (doc === null) {
    // Pi reports an extension that throws and carries on; with no `oncue`
    // provider its model is not OnCue's, and the bridge's health check says so.
    throw new Error("OnCue's Pi extension was started without its document (PI_ONCUE_CONFIG).");
  }
  pi.registerProvider(doc.provider.id, {
    name: "OnCue relay",
    baseUrl: doc.provider.baseUrl,
    apiKey: doc.provider.apiKey,
    api: doc.provider.api,
    models: [
      {
        id: doc.model.id,
        name: doc.model.name,
        reasoning: doc.model.reasoning,
        input: doc.model.input,
        // OnCue bills nothing and Pi's own accounting is not read.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: doc.model.contextWindow,
        maxTokens: doc.model.maxTokens,
      },
    ],
  });
  for (const tool of doc.tools) {
    pi.registerTool({
      name: `${doc.toolPrefix}${tool.name}`,
      label: tool.name,
      description: tool.description,
      parameters: deps.schema(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        const answer = await forwardToolCall(deps, doc.toolUrl, tool.name, params, signal);
        if (answer.isError) {
          // Pi makes a thrown error the call's failed result (`docs/extensions.md`, Tools).
          throw new Error(answer.text || "The tool failed.");
        }
        return { content: [{ type: "text", text: answer.text }], details: undefined };
      },
    });
  }
  const question = doc.question;
  if (question !== null) {
    pi.registerTool({
      name: `${doc.toolPrefix}${question.name}`,
      label: question.name,
      description: question.description,
      parameters: deps.schema(question.inputSchema),
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        if (ctx === undefined || !ctx.hasUI) {
          throw new Error("Nothing can show the question here.");
        }
        // The dialog's placeholder carries the questions to the bridge, which
        // shows them on the user's card; the call waits with no deadline.
        const answer = await ctx.ui.input(
          question.title,
          JSON.stringify({ toolCallId, input: params }),
          signal === undefined ? {} : { signal },
        );
        return questionResult(answer);
      },
    });
  }
  const held = new Set(doc.held.map((name) => `${doc.toolPrefix}${name}`));
  pi.on("tool_call", async (event, ctx) => {
    if (!held.has(event.toolName)) {
      return undefined;
    }
    if (!ctx.hasUI) {
      return { block: true, reason: "Nothing can answer this request here." };
    }
    const answer = await ctx.ui.input(
      doc.holdTitle,
      JSON.stringify({ tool: event.toolName, toolCallId: event.toolCallId, input: event.input }),
    );
    return holdDecision(answer);
  });
}
