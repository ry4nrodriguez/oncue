/**
 * The tone vocabulary shared by status badges: a status maps to a
 * `StatusTone` and a tone to a Tailwind class, so features never invent
 * their own colour for the same meaning.
 */

export type StatusTone = "positive" | "caution" | "danger" | "faint";

// Only text and dot colour: the row's opacity carries "greyed", so a revoked
// badge keeps its tone.
export const TONE_TEXT_CLASS: Record<StatusTone, string> = {
  positive: "text-positive",
  caution: "text-caution",
  danger: "text-danger",
  faint: "text-faint",
};

export const TONE_DOT_CLASS: Record<StatusTone, string> = {
  positive: "bg-positive",
  caution: "bg-caution",
  danger: "bg-danger",
  faint: "bg-faint",
};
