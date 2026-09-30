import type { SaleCurrency } from "../../lib/sale-currency";

const BLURB: Record<string, string> = {
  usdc: "Steady dollar prices",
  eth: "Bidders pay with plain ETH",
};

/**
 * What the sale raises in: two cards, one chosen. Native radio inputs (hidden
 * visually, never removed from the accessibility tree) give arrow-key movement
 * and screen-reader "1 of 2" semantics for free; the card is the label, so the
 * whole surface is the click target on a phone.
 */
export function CurrencyChoice({
  choices,
  selected,
  onChange,
  testId = "sale-currency",
}: {
  choices: readonly SaleCurrency[];
  selected: SaleCurrency;
  onChange: (value: SaleCurrency) => void;
  testId?: string;
}) {
  return (
    <fieldset data-testid={testId}>
      <legend className="text-sm font-medium text-black dark:text-white">
        The sale raises
      </legend>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {choices.map((choice) => {
          const checked = choice.kind === selected.kind;
          return (
            <label
              className={`relative flex cursor-pointer flex-col rounded-lg border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-black/40 dark:focus-within:ring-white/50 ${
                checked
                  ? "border-black bg-black/5 dark:border-white dark:bg-white/10"
                  : "border-black/15 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
              }`}
              data-testid={`${testId}-${choice.kind}`}
              key={choice.kind}
            >
              <input
                checked={checked}
                className="sr-only"
                name={testId}
                onChange={() => onChange(choice)}
                type="radio"
                value={choice.kind}
              />
              <span className="flex items-center justify-between gap-2 text-sm font-semibold text-black dark:text-white">
                {choice.symbol}
                <span
                  aria-hidden
                  className={`grid size-4 place-items-center rounded-full border ${
                    checked
                      ? "border-black dark:border-white"
                      : "border-black/30 dark:border-white/30"
                  }`}
                >
                  {checked ? (
                    <span className="size-2 rounded-full bg-black dark:bg-white" />
                  ) : null}
                </span>
              </span>
              <span className="mt-0.5 text-xs text-black/60 dark:text-white/60">
                {BLURB[choice.kind] ?? "Another token"}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
