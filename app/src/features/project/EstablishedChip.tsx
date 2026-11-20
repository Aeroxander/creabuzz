/**
 * The "Established" chip (design 2.6): drawn only for a project whose record says it reached the hint, and then as one
 * button whose text is its meaning and which opens the sheet. A hint, never a power: nothing unlocks from it.
 */
import { Check } from "lucide-react";
import { ESTABLISHED } from "./project-top-words";

export function EstablishedChip({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-mint/20 px-3.5 text-sm font-semibold text-mint-ink focus-visible:outline-2 focus-visible:outline-mint-ink"
      data-testid="established-chip"
      onClick={onOpen}
      type="button"
    >
      <Check aria-hidden="true" size={16} />
      {ESTABLISHED}
    </button>
  );
}
