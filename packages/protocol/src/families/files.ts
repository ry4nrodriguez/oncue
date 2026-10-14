import { defineFamily } from "../define";
import {
  artifactRef,
  boolean,
  boundedList,
  checkpointId,
  counter,
  exactOptional,
  fileChange,
  inlineText,
  literal,
  nullable,
  picklist,
  sha,
  shortText,
  strictObject,
  variant,
} from "../schema";

// Record 04 gives this family no payload prose beyond "meaningful state
// changes" and "not a full repository diff after every file write".
export const FILE_EVENTS = defineFamily("files", {
  "file.changed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ change: fileChange, byAgent: boolean() }),
  },
  "repository.status": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      branch: shortText,
      headSha: sha,
      baseSha: sha,
      ahead: counter,
      behind: counter,
      dirty: boolean(),
      changedFileCount: counter,
      untrackedFileCount: counter,
      additions: counter,
      deletions: counter,
    }),
  },
  "repository.checkpointed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      checkpointId,
      kind: picklist(["branch_push", "local_commit", "patch_bundle"]),
      headSha: nullable(sha),
      bundle: nullable(artifactRef),
      reason: picklist(["idle_shutdown", "user_requested", "pre_replacement", "periodic", "pause"]),
    }),
  },
  "diff.updated": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    // `turn` is what one run changed, measured from the snapshot the bridge
    // took when the run started; `session` is everything since the session's
    // recorded base.
    payload: strictObject({
      scope: picklist(["turn", "session"]),
      baseSha: sha,
      headSha: sha,
      files: boundedList(fileChange),
      additions: counter,
      deletions: counter,
      body: variant("kind", [
        strictObject({ kind: literal("inline"), patch: inlineText }),
        strictObject({ kind: literal("artifact"), artifact: artifactRef }),
      ]),
      truncated: boolean(),
      // Every path in the tree at `headSha`, one per line, as an artifact, so
      // the review can draw the whole repository. Absent on older events; null
      // when the bridge had no room to upload one.
      tree: exactOptional(nullable(artifactRef)),
    }),
  },
});
