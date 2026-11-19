/** The one sentence that goes wherever money is offered, word for word. Never reworded and never hidden. */
const OWNERSHIP_LINE =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";

export function OwnershipLine({ className }: { className?: string }) {
  return (
    <p className={className ?? "text-sm text-muted"} data-testid="ownership">
      {OWNERSHIP_LINE}
    </p>
  );
}
