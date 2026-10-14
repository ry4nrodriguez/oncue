// Local replacements for the types AI Elements imports from the Vercel AI SDK.
// Record 24 forbids the SDK as a dependency, and its source imports these only
// as types, so the imports are repointed here.

export type MessageRole = "system" | "user" | "assistant";

export type UIMessage = {
  id: string;
  role: MessageRole;
};
