import type { PayloadInputOf } from "../events";
import type { artifactRef, fileChange, InferInput, modelRecord, tokenUsage } from "../schema";

export const TEST_SHA = "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
export const TEST_HEAD_SHA = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
export const TEST_SHA256 = "0123456789abcdef".repeat(4);
export const TEST_BRANCH = "oncue/session-1";

export function testArtifactRef(
  overrides: Partial<InferInput<typeof artifactRef>> = {},
): InferInput<typeof artifactRef> {
  return {
    artifactId: "art_1",
    kind: "log",
    contentType: "text/plain",
    byteSize: 1024,
    label: "test.log",
    ...overrides,
  };
}

export function testFileChange(
  overrides: Partial<InferInput<typeof fileChange>> = {},
): InferInput<typeof fileChange> {
  return {
    path: "src/index.ts",
    status: "modified",
    additions: 3,
    deletions: 1,
    ...overrides,
  };
}

export function testTokenUsage(): InferInput<typeof tokenUsage> {
  return { usedTokens: 1200, maxTokens: 200000 };
}

export function testModelRecord(): InferInput<typeof modelRecord> {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    modelConnectionId: "conn_1",
    authenticationType: "api_key",
    contextWindow: 200000,
    effort: null,
  };
}

export function testCompletionSummary(): PayloadInputOf<"run.verified">["summary"] {
  return {
    whatChanged: "Fixed the failing unit test in src/index.ts.",
    why: "The assertion compared a string to a number.",
    verificationPerformed: "pnpm test passed.",
    limitations: [],
    nextStep: null,
  };
}

export function testOutcomeTail(): Pick<
  PayloadInputOf<"run.verified">,
  "evidence" | "branch" | "pullRequestNumber" | "usage" | "durationMs"
> {
  return {
    evidence: [],
    branch: TEST_BRANCH,
    pullRequestNumber: null,
    usage: null,
    durationMs: 60000,
  };
}

export function testSessionPolicy(
  overrides: Partial<PayloadInputOf<"policy.updated">["to"]> = {},
): PayloadInputOf<"policy.updated">["to"] {
  return {
    version: 1,
    commit: "auto",
    push: "manual",
    pullRequest: "manual",
    planApproval: "proceed",
    fileEdits: "allowed",
    ...overrides,
  };
}

export function testPlanStep(
  overrides: Partial<PayloadInputOf<"plan.created">["steps"][number]> = {},
): PayloadInputOf<"plan.created">["steps"][number] {
  return {
    stepId: "step_1",
    title: "Reproduce the failure",
    status: "pending",
    ...overrides,
  };
}

export function testPolicyDecisionRef(): PayloadInputOf<"git.committed">["policy"] {
  return { policyVersion: 1, rule: "auto_commit", approvalId: null };
}

export function testOutcomeCounts(
  overrides: Partial<PayloadInputOf<"verification.completed">["required"]> = {},
): PayloadInputOf<"verification.completed">["required"] {
  return { total: 0, passed: 0, failed: 0, skipped: 0, inconclusive: 0, ...overrides };
}
