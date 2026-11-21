import { useId } from "react";
import { BRAIN_WORDS } from "./brain-copy";

/**
 * Start's one optional line about the project brain (docs/MANAGEMENT-LAYER.md section 9, step B3). One press to say yes,
 * none to skip; it is not an answer, so Start needs nothing from it. It never blocks Start: a "yes" only decides what
 * the project page shows first (the steps for keeping a brain).
 */
export function BrainOffer({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hint = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm font-semibold text-ink">
        <input
          aria-describedby={hint}
          checked={checked}
          className="mt-0.5 size-5 shrink-0 accent-current"
          data-testid="start-brain"
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span>{BRAIN_WORDS.offerLabel}</span>
      </label>
      <p className="text-sm text-muted" id={hint}>
        {BRAIN_WORDS.offerHint}
      </p>
    </div>
  );
}
