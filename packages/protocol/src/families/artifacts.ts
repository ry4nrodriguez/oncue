import { defineFamily } from "../define";
import {
  artifactId,
  artifactKind,
  artifactRef,
  boolean,
  counter,
  literal,
  nullable,
  picklist,
  sha256Hex,
  shortText,
  strictObject,
  summaryText,
  timestamp,
} from "../schema";

export const artifactProducer = picklist([
  "tool",
  "verification",
  "checkpoint",
  "screenshot",
  "log",
  "agent",
]);

// Record 04's artifact completion event is `artifact.created`. It carries
// durable metadata and never a local sandbox path.
export const ARTIFACT_EVENTS = defineFamily("artifacts", {
  "artifact.uploading": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      artifactId,
      kind: artifactKind,
      contentType: shortText,
      declaredBytes: counter,
      producer: artifactProducer,
    }),
  },
  // Control-origin: only the control plane can attest that the bytes landed
  // with a matching checksum (record 03).
  "artifact.created": {
    scope: "run",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      artifact: artifactRef,
      checksum: strictObject({ algorithm: literal("sha256"), value: sha256Hex }),
      producer: artifactProducer,
      // Record 19's two retention classes, decided at creation.
      classification: picklist(["essential_evidence", "temporary"]),
      expiresAt: nullable(timestamp),
      supersedes: nullable(artifactId),
    }),
  },
  "artifact.failed": {
    scope: "run",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      artifactId,
      stage: picklist(["authorize", "upload", "validate", "commit"]),
      reason: summaryText,
      retryable: boolean(),
    }),
  },
});
