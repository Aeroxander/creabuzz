/**
 * Three starting sizes for a raise, so a founder who does not know what to ask for is not left with an empty box.
 *
 * Each is a raise target and a sale length, nothing more: the supply split, the milestone unlocks and the rest keep
 * their standard values, and every number can still be changed. They are starting points, not advice about what a
 * project is worth. The middle one is the app's own default (`quick-sale.ts`), so there is one idea of "standard".
 *
 * Alias-free for `node --test`.
 */

import type { DurationPreset } from "./sale-plans.ts";

export type RaisePresetKey = "small" | "standard" | "large";

export interface RaisePreset {
  key: RaisePresetKey;
  label: string;
  /** One plain line on what it is. */
  blurb: string;
  /** The target in whole units: USDC (and any dollar-like token) and ETH have different scales. */
  target: { dollars: string; eth: string };
  duration: DurationPreset["key"];
}

export const RAISE_PRESETS: readonly RaisePreset[] = [
  {
    key: "small",
    label: "Small",
    blurb: "A smaller target, over a shorter sale.",
    target: { dollars: "50000", eth: "20" },
    duration: "3d",
  },
  {
    key: "standard",
    label: "Standard",
    blurb: "The app's usual starting point.",
    target: { dollars: "300000", eth: "120" },
    duration: "7d",
  },
  {
    key: "large",
    label: "Large",
    blurb: "A bigger target, over a longer sale.",
    target: { dollars: "1000000", eth: "400" },
    duration: "14d",
  },
];

/** The preset's target in the sale currency's own scale. */
export function presetTarget(
  preset: RaisePreset,
  currencyKind: string,
): string {
  return currencyKind === "eth" ? preset.target.eth : preset.target.dollars;
}

const plain = (value: string): string => value.replace(/[,_\s]/g, "");

/**
 * The preset the current numbers are exactly, or null when they are the founder's own. Commas and spaces in the typed
 * target do not matter.
 */
export function activePreset(
  currencyKind: string,
  raiseTarget: string,
  durationKey: string,
): RaisePresetKey | null {
  const typed = plain(raiseTarget);
  const hit = RAISE_PRESETS.find(
    (preset) =>
      presetTarget(preset, currencyKind) === typed &&
      preset.duration === durationKey,
  );
  return hit?.key ?? null;
}
