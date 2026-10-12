/**
 * The quick sale setup: how much to raise and for how long. Everything else is
 * defaulted and listed, so nothing is hidden, and "Customize" opens the full
 * step-by-step setup with the same values filled in.
 */

import { Button } from "@/shared/ui/button";

import type { RaisePreset } from "../../lib/raise-presets";
import { SALE_DURATIONS } from "../../lib/sale-plans";
import { PresetPicker } from "./PresetPicker";
import type { DurationKey } from "../../lib/wizard";

export interface QuickSaleProps {
  launchName: string;
  currencySymbol: string;
  /** `eth` or a dollar-like token: the presets' targets are in that scale. */
  currencyKind: string;
  raiseTarget: string;
  onRaiseTarget(value: string): void;
  durationKey: DurationKey;
  onDuration(key: DurationKey): void;
  onPreset(preset: RaisePreset): void;
  /** What the founder is not asked about, in plain words. */
  defaults: ReadonlyArray<{ label: string; value: string }>;
  /** Why the sale cannot be published yet; empty when it can. */
  issues: readonly string[];
  onCustomize(): void;
}

export function QuickSale({
  launchName,
  currencySymbol,
  currencyKind,
  raiseTarget,
  onRaiseTarget,
  durationKey,
  onDuration,
  onPreset,
  defaults,
  issues,
  onCustomize,
}: QuickSaleProps) {
  return (
    <section className="flex flex-col gap-4" data-testid="quick-sale">
      <div>
        <h3 className="text-sm font-bold">Open a sale for {launchName}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Pick a size, or set your own target and length. We set the rest the
          standard way, and you can change any of it.
        </p>
      </div>
      <PresetPicker
        currencyKind={currencyKind}
        currencySymbol={currencySymbol}
        durationKey={durationKey}
        onPick={onPreset}
        raiseTarget={raiseTarget}
      />
      <div>
        <label className="text-sm font-medium" htmlFor="quick-raise">
          How much do you want to raise? ({currencySymbol})
        </label>
        <input
          className="mt-1 h-10 w-full rounded-md border border-input bg-background/60 px-3 text-lg font-bold tabular-nums focus:border-ring focus:outline-none"
          data-testid="quick-raise"
          id="quick-raise"
          inputMode="decimal"
          onChange={(event) => onRaiseTarget(event.target.value)}
          value={raiseTarget}
        />
      </div>
      <fieldset>
        <legend className="text-sm font-medium">
          How long does the sale run?
        </legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {SALE_DURATIONS.filter((duration) => duration.key !== "custom").map(
            (duration) => (
              <button
                aria-pressed={durationKey === duration.key}
                className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
                  durationKey === duration.key
                    ? "border-primary bg-primary/15 text-primary-ink"
                    : "border-border"
                }`}
                data-testid={`quick-duration-${duration.key}`}
                key={duration.key}
                onClick={() => onDuration(duration.key)}
                type="button"
              >
                {duration.label}
              </button>
            ),
          )}
        </div>
      </fieldset>
      <dl
        className="divide-y divide-border/60 rounded-xl border border-border/60 bg-foreground/[0.04] px-3"
        data-testid="quick-defaults"
      >
        {defaults.map((row) => (
          <div
            className="flex justify-between gap-4 py-2 text-sm"
            key={row.label}
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
      {issues.length > 0 ? (
        <ul
          className="space-y-0.5 text-xs text-red-600 dark:text-red-400"
          data-testid="quick-issues"
        >
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button
          data-testid="quick-customize"
          onClick={onCustomize}
          size="sm"
          type="button"
          variant="ghost"
        >
          Customize the details
        </Button>
      </div>
    </section>
  );
}
