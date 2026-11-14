/**
 * Three starting sizes for a raise. Picking one fills in the raise target and the sale length; the founder can change
 * either afterwards, and the picker then lets go of its highlight because the numbers are theirs.
 */

import {
  activePreset,
  presetTarget,
  RAISE_PRESETS,
  type RaisePreset,
} from "../../lib/raise-presets";
import { SALE_DURATIONS } from "../../lib/sale-plans";

const groups = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

export function PresetPicker({
  currencyKind,
  currencySymbol,
  raiseTarget,
  durationKey,
  onPick,
}: {
  currencyKind: string;
  currencySymbol: string;
  raiseTarget: string;
  durationKey: string;
  onPick(preset: RaisePreset): void;
}) {
  const active = activePreset(currencyKind, raiseTarget, durationKey);
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" data-testid="raise-presets">
      <legend className="text-sm font-medium">Pick a size to start from</legend>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
        {RAISE_PRESETS.map((preset) => {
          const length = SALE_DURATIONS.find(
            (duration) => duration.key === preset.duration,
          )?.label;
          return (
            <button
              aria-pressed={active === preset.key}
              className={`rounded-xl border p-3 text-left ${
                active === preset.key
                  ? "border-primary bg-primary/15"
                  : "border-border"
              }`}
              data-testid={`raise-preset-${preset.key}`}
              key={preset.key}
              onClick={() => onPick(preset)}
              type="button"
            >
              <span className="block text-sm font-bold">{preset.label}</span>
              <span className="block text-sm tabular-nums">
                {groups.format(Number(presetTarget(preset, currencyKind)))}{" "}
                {currencySymbol} · {length}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {preset.blurb}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        These are starting points, not advice on what a project is worth. Change
        the target or the length and it becomes your own.
      </p>
    </fieldset>
  );
}
