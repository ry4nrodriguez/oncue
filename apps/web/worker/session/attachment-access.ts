// The session object's side of composer attachments (docs/decisions.md). Each
// send mints one fetch token per attachment, stored only as a hash; a token
// works once, for ten minutes, and only for its generation, so a replaced
// sandbox cannot spend its predecessor's tokens.

import type { AttachmentFetch } from "@oncue/bridge";
import type { ArtifactRef, ProtocolCommand } from "@oncue/protocol";

export const ATTACHMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

/** The attachments a message-carrying command names; none for every other command. */
export function commandAttachments(command: ProtocolCommand): readonly ArtifactRef[] {
  if (command.type === "run.start") {
    return command.payload.instruction.attachments;
  }
  if (command.type === "run.follow_up") {
    return command.payload.attachments;
  }
  return [];
}

/** The command with `refs` in place of the attachments it named. Other commands are returned as they are. */
export function withAttachments(
  command: ProtocolCommand,
  refs: readonly ArtifactRef[],
): ProtocolCommand {
  if (command.type === "run.start") {
    const instruction = { ...command.payload.instruction, attachments: [...refs] };
    return { ...command, payload: { ...command.payload, instruction } };
  }
  if (command.type === "run.follow_up") {
    return { ...command, payload: { ...command.payload, attachments: [...refs] } };
  }
  return command;
}

export interface MintInput {
  readonly sql: SqlStorage;
  readonly sessionId: string;
  readonly generation: number;
  /** The origin the bridge reached the control plane at. */
  readonly origin: string;
  readonly refs: readonly ArtifactRef[];
  readonly nowMs: number;
  readonly mint: () => string;
  readonly hash: (token: string) => Promise<string>;
}

export async function mintAttachmentFetches(input: MintInput): Promise<AttachmentFetch[]> {
  // Pruning expired rows first bounds the table to ten minutes of sends.
  input.sql.exec("DELETE FROM attachment_access WHERE expires_at_ms <= ?", input.nowMs);
  const fetches: AttachmentFetch[] = [];
  for (const ref of input.refs) {
    const token = input.mint();
    input.sql.exec(
      "INSERT INTO attachment_access (token_sha256, attachment_id, generation, expires_at_ms, used_at) VALUES (?,?,?,?,NULL)",
      await input.hash(token),
      ref.artifactId,
      input.generation,
      input.nowMs + ATTACHMENT_TOKEN_TTL_MS,
    );
    fetches.push({
      artifactId: ref.artifactId,
      name: ref.label,
      contentType: ref.contentType,
      byteSize: ref.byteSize,
      url: `${input.origin}/api/sessions/${input.sessionId}/attachments/${encodeURIComponent(ref.artifactId)}/content`,
      token,
    });
  }
  return fetches;
}

export interface SpendInput {
  readonly sql: SqlStorage;
  readonly attachmentId: string;
  readonly tokenSha256: string;
  readonly generation: number;
  readonly nowMs: number;
  readonly now: string;
}

/** True once per token, for its own attachment and generation, before expiry; every refusal looks the same. */
export function spendAttachmentToken(input: SpendInput): boolean {
  const row = input.sql
    .exec<{
      attachment_id: string;
      generation: number;
      expires_at_ms: number;
      used_at: string | null;
    }>(
      "SELECT attachment_id, generation, expires_at_ms, used_at FROM attachment_access WHERE token_sha256 = ?",
      input.tokenSha256,
    )
    .toArray()[0];
  if (
    row === undefined ||
    row.attachment_id !== input.attachmentId ||
    row.generation !== input.generation ||
    row.used_at !== null ||
    row.expires_at_ms <= input.nowMs
  ) {
    return false;
  }
  input.sql.exec(
    "UPDATE attachment_access SET used_at = ? WHERE token_sha256 = ?",
    input.now,
    input.tokenSha256,
  );
  return true;
}
