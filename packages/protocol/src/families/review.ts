import { defineFamily } from "../define";
import {
  boolean,
  boundedList,
  commandId,
  counter,
  nullable,
  number,
  picklist,
  reviewItemId,
  sha,
  shortText,
  strictObject,
  summaryText,
  timestamp,
  untrustedText,
  userId,
} from "../schema";
import { REVIEW_ACTION_STATES } from "../states";

// Record 16's action states, derived from `states.ts` so the schema cannot
// accept a state the machine does not know.
export const reviewActionState = picklist(REVIEW_ACTION_STATES);

export const githubReviewState = picklist([
  "commented",
  "approved",
  "changes_requested",
  "dismissed",
]);

// Every field GitHub authored is UntrustedText, per record 16.
export const REVIEW_EVENTS = defineFamily("review", {
  "review.imported": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      reviewItemId,
      githubId: shortText,
      pullRequestNumber: counter,
      author: untrustedText,
      authorType: picklist(["human", "bot"]),
      body: untrustedText,
      sourceType: picklist(["review", "issue_comment", "review_comment", "reply"]),
      location: nullable(
        strictObject({
          path: shortText,
          line: nullable(number()),
          side: picklist(["LEFT", "RIGHT"]),
          commitSha: sha,
        }),
      ),
      threadId: nullable(shortText),
      parentId: nullable(shortText),
      githubState: githubReviewState,
      locationCurrent: boolean(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  },
  "review.updated": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      reviewItemId,
      actionState: reviewActionState,
      body: nullable(untrustedText),
      githubState: githubReviewState,
      locationCurrent: boolean(),
      updatedAt: timestamp,
    }),
  },
  "review.selected": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      reviewItemIds: boundedList(reviewItemId),
      commandId,
      userId,
    }),
  },
  // Record 16: a comment stays "needs attention" when the change could not
  // be completed or verified, so the outcome is explicit.
  "review.addressed": {
    scope: "run",
    origin: "sandbox",
    durability: "durable",
    payload: strictObject({
      reviewItemId,
      outcome: picklist(["addressed", "needs_clarification"]),
      summary: summaryText,
      question: nullable(summaryText),
      commits: boundedList(sha),
      verificationChecks: boundedList(shortText),
      verified: boolean(),
    }),
  },
  "review.dismissed": {
    scope: "session",
    origin: "control",
    durability: "durable",
    payload: strictObject({
      reviewItemId,
      userId,
      reason: nullable(summaryText),
    }),
  },
});
