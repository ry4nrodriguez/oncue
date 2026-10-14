import { defineFamily } from "../define";
import {
  boundedList,
  counter,
  exactOptional,
  nullable,
  picklist,
  planId,
  shortText,
  strictObject,
  summaryText,
} from "../schema";

export const planStepStatus = picklist(["pending", "active", "complete", "blocked", "skipped"]);

export const planStep = strictObject({
  stepId: shortText,
  title: shortText,
  description: exactOptional(summaryText),
  status: planStepStatus,
  blockedReason: exactOptional(summaryText),
});

// Every plan event carries the whole plan keyed by `revision`, so the fold is
// a replacement and a missed update cannot corrupt the view. Plans are small
// by design (record 12, "Plan shape").
const planBody = {
  planId,
  revision: counter,
  title: shortText,
  description: exactOptional(summaryText),
  steps: boundedList(planStep),
  activeStepId: nullable(shortText),
  expectedVerification: boundedList(shortText),
} as const;

export const PLAN_EVENTS = defineFamily("plans", {
  "plan.created": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ ...planBody }),
  },
  // A non-null `changeSummary` is a revision; record 12 requires the change
  // to be explained in plain language. Null is a routine step advance.
  "plan.updated": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ ...planBody, changeSummary: nullable(summaryText) }),
  },
  "plan.completed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({ planId, revision: counter, summary: summaryText }),
  },
  "plan.blocked": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      planId,
      revision: counter,
      stepId: nullable(shortText),
      question: summaryText,
    }),
  },
  "plan.cancelled": {
    scope: "run",
    origin: "either",
    durability: "durable",
    payload: strictObject({
      planId,
      revision: counter,
      reason: picklist(["user_cancelled", "run_cancelled", "superseded"]),
    }),
  },
});
