/**
 * The words for a model key that stopped working (record 15), shared by the
 * model picker's rows and Home's banner. `Record`s over the closed status
 * union, so a new status is a compile error rather than a blank.
 */
import type { InactiveKeyStatus, InactiveModelConnection } from "@/lib/api/setup";
import { PROVIDER_LABEL } from "./connection-status";

/** On a model's row in the picker, beside the way to replace the key. */
export const INACTIVE_KEY_WORDS: Record<InactiveKeyStatus, string> = {
  invalid: "Key rejected",
  expired: "Key expired",
  attention_required: "Key needs attention",
};

const INACTIVE_KEY_SENTENCE: Record<InactiveKeyStatus, string> = {
  invalid: "was rejected",
  expired: "has expired",
  attention_required: "needs attention",
};

/** What a link to Settings, Model providers is called where a key must be replaced. */
export const REPLACE_KEY = "Replace the key";

/** How many active sessions are on the key, and what that means for them. */
function sessionsSentence(count: number): string {
  if (count === 0) {
    return "No active session uses it.";
  }
  const sessions = count === 1 ? "1 active session uses" : `${count} active sessions use`;
  return `${sessions} it and can't continue until the key is replaced.`;
}

/** Home's banner for one key: which provider, what happened, and who is waiting on it. */
export function inactiveKeyBanner(connection: InactiveModelConnection): string {
  return `The ${PROVIDER_LABEL[connection.provider]} key ${
    INACTIVE_KEY_SENTENCE[connection.status]
  }. ${sessionsSentence(connection.activeSessions)}`;
}
