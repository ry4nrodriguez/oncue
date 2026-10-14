/**
 * Button classes shared by the settings and setup screens. The composer's
 * send is the app's one accent; every other action is a neutral bordered
 * button that reads the same in both themes.
 */

/** A primary action: Connect, Save and continue, Test and connect. */
export const NEUTRAL_BUTTON =
  "flex items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-3.5 py-2 text-[13px] text-text transition-colors hover:bg-hover disabled:opacity-60";

/** The same, full width, for a form's submit. */
export const NEUTRAL_BUTTON_BLOCK = `${NEUTRAL_BUTTON} w-full py-2.5 text-[14px]`;

/** A quiet row action: Replace, Revoke, Disconnect, Remove. */
export const ROW_ACTION =
  "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-text disabled:opacity-60";

/** A destructive confirmation inside a dialog: neutral chrome, the word in the danger colour. */
export const DANGER_ACTION = `${NEUTRAL_BUTTON} text-danger hover:bg-hover`;

/** A bordered group of rows, the page's own background showing through. */
export const GROUP = "overflow-hidden rounded-xl border border-border";
