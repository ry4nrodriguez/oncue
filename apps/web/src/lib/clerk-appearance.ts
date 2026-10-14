/**
 * The theme for Clerk's sign-in and sign-up components (record 13). Clerk
 * still owns the form; this only restyles it: no card or shadow, borders
 * instead of fills, and a neutral primary button. Every colour is a token
 * from `styles/tokens.css` read through `var()`, so the form follows the
 * theme. Clerk derives borders and muted greys from `colorNeutral`.
 */

// Clerk declares its own `--border` on its buttons, hiding ours, so the tokens
// are copied onto Clerk's root box under names Clerk does not use.
const ALIASES = {
  "--oncue-border": "var(--border)",
  "--oncue-hover": "var(--hover)",
  "--oncue-text": "var(--text)",
} as const;

/**
 * A neutral bordered button, matching `NEUTRAL_BUTTON`. Clerk's edge
 * `box-shadow` and its `::after` sheen outrank appearance overrides, hence
 * `!important`. The hover rule stops Clerk filling a hovered button with a
 * near-black `colorPrimary`; Clerk warns about state selectors here, but they
 * target the button's own states, not Clerk's inner DOM.
 */
const NEUTRAL = {
  backgroundColor: "transparent",
  backgroundImage: "none",
  color: "var(--oncue-text)",
  boxShadow: "0 0 0 1px var(--oncue-border) !important",
  "&::after": { backgroundImage: "none !important" },
  "&:hover, &:focus-visible, &:active": {
    backgroundColor: "var(--oncue-hover)",
    color: "var(--oncue-text)",
  },
} as const;

export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: "var(--text)",
    colorPrimaryForeground: "var(--canvas)",
    colorBackground: "var(--canvas)",
    colorForeground: "var(--text)",
    colorMutedForeground: "var(--muted)",
    colorMuted: "var(--surface)",
    colorNeutral: "var(--text)",
    colorInput: "var(--canvas)",
    colorInputForeground: "var(--text)",
    colorRing: "var(--muted)",
    colorShadow: "transparent",
    colorDanger: "var(--danger)",
    colorSuccess: "var(--positive)",
    colorWarning: "var(--caution)",
    fontFamily: "inherit",
    borderRadius: "0.5rem",
  },
  options: {
    // The "Development mode" strip describes the Clerk instance, not anything the user can act on.
    unsafe_disableDevelopmentModeWarnings: true,
  },
  elements: {
    rootBox: { width: "100%", ...ALIASES },
    // The panel's wordmark already names OnCue.
    headerTitle: { display: "none" },
    cardBox: {
      width: "100%",
      boxShadow: "none",
      border: "none",
      borderRadius: 0,
      backgroundColor: "transparent",
      // Clerk draws edges as an outer box-shadow; clipping would cut the side edges.
      overflow: "visible",
    },
    card: {
      boxShadow: "none",
      border: "none",
      backgroundColor: "transparent",
      // The panel around the form already pads it.
      padding: 0,
    },
    footer: {
      background: "transparent",
      backgroundImage: "none",
      "& > *": { borderTop: "none" },
    },
    socialButtonsBlockButton: NEUTRAL,
    formButtonPrimary: NEUTRAL,
    formFieldInput: { backgroundColor: "transparent" },
    footerActionLink: {
      color: "var(--oncue-text)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
    },
  },
};
