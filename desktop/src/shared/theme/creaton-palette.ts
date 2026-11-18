/**
 * The Creaton look for the first-party "Buzz" themes: a violet-black page with
 * raised violet cards and a mint action colour, matching the web client. Other
 * themes (the Shiki palettes) keep deriving everything from their own colours.
 *
 * Values are `h s% l%` triples for the shadcn CSS variables, the same numbers
 * as `web/src/shared/styles/globals.css`.
 */

/** The action colour (buttons, selection, focus). */
export const CREATON_MINT = "#35cc82";

type VarMap = Record<string, string>;

const DARK: VarMap = {
  "--background": "266 66% 8%",
  "--card": "266 31% 16%",
  "--card-foreground": "0 0% 100%",
  "--popover": "266 31% 14%",
  "--popover-foreground": "0 0% 100%",
  "--foreground": "0 0% 100%",
  "--secondary": "266 31% 24%",
  "--secondary-foreground": "0 0% 100%",
  "--muted": "266 31% 24%",
  "--muted-foreground": "255 20% 78%",
  "--accent": "266 31% 24%",
  "--accent-foreground": "0 0% 100%",
  "--border": "266 24% 28%",
  "--input": "266 24% 28%",
  "--ring": "153 59% 50%",
  "--sidebar-background": "266 55% 10%",
  "--sidebar-foreground": "0 0% 100%",
  "--sidebar-accent": "266 31% 16%",
  "--sidebar-accent-foreground": "0 0% 100%",
  "--sidebar-border": "266 24% 28%",
  "--sidebar-ring": "153 59% 50%",
  "--primary": "153 59% 50%",
  "--primary-foreground": "266 43% 17%",
  "--sidebar-primary": "153 59% 50%",
  "--sidebar-primary-foreground": "266 43% 17%",
  "--sidebar-active": "153 59% 50%",
  "--sidebar-active-foreground": "266 43% 17%",
};

const LIGHT: VarMap = {
  "--background": "260 30% 97%",
  "--card": "0 0% 100%",
  "--card-foreground": "266 43% 17%",
  "--popover": "0 0% 100%",
  "--popover-foreground": "266 43% 17%",
  "--foreground": "266 43% 17%",
  "--secondary": "262 30% 92%",
  "--secondary-foreground": "266 43% 17%",
  "--muted": "262 30% 92%",
  "--muted-foreground": "262 14% 36%",
  "--accent": "262 30% 92%",
  "--accent-foreground": "266 43% 17%",
  "--border": "262 20% 84%",
  "--input": "262 20% 84%",
  "--ring": "153 59% 36%",
  "--sidebar-background": "260 30% 95%",
  "--sidebar-foreground": "266 43% 17%",
  "--sidebar-accent": "0 0% 100%",
  "--sidebar-accent-foreground": "266 43% 17%",
  "--sidebar-border": "262 20% 84%",
  "--sidebar-ring": "153 59% 36%",
  "--primary": "153 59% 47%",
  "--primary-foreground": "266 43% 17%",
  "--sidebar-primary": "153 59% 47%",
  "--sidebar-primary-foreground": "266 43% 17%",
  "--sidebar-active": "153 59% 47%",
  "--sidebar-active-foreground": "266 43% 17%",
};

/** The variables a Buzz theme overrides on top of the derived ones. */
export function creatonVars(isDark: boolean): VarMap {
  return { ...(isDark ? DARK : LIGHT) };
}

/** Text on mint is always the deep violet, in both modes. */
export const CREATON_ON_MINT = "266 43% 17%";
