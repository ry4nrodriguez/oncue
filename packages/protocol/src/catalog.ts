import { EVENT_FAMILIES, type EventFamily, type EventSpec } from "./define";
import { AGENT_EVENTS } from "./families/agents";
import { APPROVAL_EVENTS } from "./families/approvals";
import { ARTIFACT_EVENTS } from "./families/artifacts";
import { FILE_EVENTS } from "./families/files";
import { GIT_EVENTS } from "./families/git";
import { LIFECYCLE_EVENTS } from "./families/lifecycle";
import { MESSAGE_EVENTS } from "./families/messages";
import { PLAN_EVENTS } from "./families/plans";
import { POLICY_EVENTS } from "./families/policy";
import { QUESTION_EVENTS } from "./families/questions";
import { REVIEW_EVENTS } from "./families/review";
import { SANDBOX_EVENTS } from "./families/sandbox";
import { TOOL_EVENTS } from "./families/tools";
import { VERIFICATION_EVENTS } from "./families/verification";

// `satisfies`, not an annotation, so every literal key and payload schema type
// survives into the derived union.
export const EVENT_CATALOG = {
  ...LIFECYCLE_EVENTS,
  ...MESSAGE_EVENTS,
  ...PLAN_EVENTS,
  ...TOOL_EVENTS,
  ...FILE_EVENTS,
  ...GIT_EVENTS,
  ...POLICY_EVENTS,
  ...SANDBOX_EVENTS,
  ...REVIEW_EVENTS,
  ...VERIFICATION_EVENTS,
  ...APPROVAL_EVENTS,
  ...QUESTION_EVENTS,
  ...ARTIFACT_EVENTS,
  ...AGENT_EVENTS,
} satisfies Record<string, EventSpec>;

export type EventCatalog = typeof EVENT_CATALOG;
export type EventType = keyof EventCatalog & string;

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as readonly EventType[];

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOG, value);
}

export function specOf<T extends EventType>(type: T): EventCatalog[T] {
  return EVENT_CATALOG[type];
}

export type FamilyOf<T extends EventType> = EventCatalog[T]["family"];
export type ScopeOf<T extends EventType> = EventCatalog[T]["scope"];
export type OriginOf<T extends EventType> = EventCatalog[T]["origin"];
export type DurabilityOf<T extends EventType> = EventCatalog[T]["durability"];

export type EventTypeIn<F extends EventFamily> = {
  [T in EventType]: FamilyOf<T> extends F ? T : never;
}[EventType];

export type EphemeralEventType = {
  [T in EventType]: DurabilityOf<T> extends "ephemeral" ? T : never;
}[EventType];
export type DurableEventType = Exclude<EventType, EphemeralEventType>;

export function eventTypesIn<F extends EventFamily>(family: F): readonly EventTypeIn<F>[] {
  return EVENT_TYPES.filter(
    (type): type is EventTypeIn<F> => EVENT_CATALOG[type].family === family,
  );
}

// Same shape as ALLOWLIST_MATCHES_LOG_FIELDS in apps/web/worker/log.ts: a
// family declared but unused, or used but undeclared, fails to compile.
type UsedFamily = FamilyOf<EventType>;
export const FAMILIES_MATCH_CATALOG: [
  Exclude<EventFamily, UsedFamily> extends never ? true : never,
  Exclude<UsedFamily, EventFamily> extends never ? true : never,
] = [true, true];

export { EVENT_FAMILIES };
