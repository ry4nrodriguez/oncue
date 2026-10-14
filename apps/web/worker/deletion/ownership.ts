// Which R2 objects a session's deletion may remove (record 19, step 6). An
// object is removed only when its key is exactly where OnCue would have put it
// for this workspace and session; anything else is left alone and counted,
// whatever row named it.

import { attachmentObjectKey } from "../attachments/store";

/** An artifact's key: `workspaces/<ws>/sessions/<session>/runs/<run>/<artifact>` (`artifactObjectKey`). */
export function ownsArtifactKey(key: string, workspaceId: string, sessionId: string): boolean {
  const prefix = `workspaces/${workspaceId}/sessions/${sessionId}/runs/`;
  if (!key.startsWith(prefix)) {
    return false;
  }
  const rest = key.slice(prefix.length).split("/");
  return rest.length === 2 && rest.every((segment) => segment.length > 0);
}

export interface AttachmentObject {
  readonly attachmentId: string;
  readonly objectKey: string;
}

/** An attachment's key is rebuilt from the workspace and its own id, never trusted from the row. */
export function ownsAttachmentKey(attachment: AttachmentObject, workspaceId: string): boolean {
  return attachment.objectKey === attachmentObjectKey(workspaceId, attachment.attachmentId);
}

export interface ObjectPlan {
  /** Distinct keys to delete, in a stable order. */
  readonly owned: readonly string[];
  /** Keys some row named that do not belong to this session; never touched. */
  readonly skipped: number;
}

export function planObjectRemoval(
  workspaceId: string,
  sessionId: string,
  artifactKeys: readonly string[],
  attachments: readonly AttachmentObject[],
): ObjectPlan {
  const owned = new Set<string>();
  let skipped = 0;
  for (const key of artifactKeys) {
    if (ownsArtifactKey(key, workspaceId, sessionId)) {
      owned.add(key);
    } else {
      skipped += 1;
    }
  }
  for (const attachment of attachments) {
    if (ownsAttachmentKey(attachment, workspaceId)) {
      owned.add(attachment.objectKey);
    } else {
      skipped += 1;
    }
  }
  return { owned: [...owned].sort(), skipped };
}
