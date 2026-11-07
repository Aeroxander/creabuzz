import { TextField } from "@/features/launchpad/ui/decision-fields";

import type { ContributorDraft } from "../lib/contributor-project";
import { SALE_DEFAULTS, type SaleField } from "../lib/weekly-sale";

/**
 * The weekly sale of Shares, for a project started on the weekly-sale kit (`lib/weekly-sale.ts`): how many Shares one lot
 * holds, and how the founder's own Shares unlock for sale. The defaults are filled in, so a founder who changes nothing
 * starts with a sensible schedule; buyers pay in the free test token, which is said here and again on the Trading card.
 */
export function WeeklySaleFields({
  draft,
  errorFor,
  onChange,
}: {
  draft: ContributorDraft;
  errorFor: (field: SaleField) => string | null;
  onChange: (patch: Pick<ContributorDraft, SaleField>) => void;
}) {
  const value = (field: SaleField, fallback: string) =>
    draft[field] ?? fallback;
  const patch = (field: SaleField) => (text: string) =>
    onChange({ [field]: text } as Pick<ContributorDraft, SaleField>);
  return (
    <fieldset className="flex flex-col gap-3" data-testid="contributor-weekly">
      <legend className="text-sm font-semibold">Weekly sale of Shares</legend>
      <p className="text-xs text-muted-foreground">
        Once the project votes to open its market, holders can offer Shares and
        buyers can bid for them each week. Buyers pay with a free test token
        that is worth nothing, so a price here proves nothing. Your own Shares
        can be offered only as they unlock; this limits you, not other holders.
      </p>
      <TextField
        error={errorFor("saleLot")}
        hint="People offer and bid in whole lots. Use a smaller lot to sell less at a time."
        inputMode="decimal"
        label="Shares in one lot"
        onChange={patch("saleLot")}
        testId="contributor-sale-lot"
        value={value("saleLot", SALE_DEFAULTS.lot)}
      />
      <TextField
        error={errorFor("saleCliffDays")}
        hint="0 means your Shares start to unlock at once."
        inputMode="numeric"
        label="Days before you can sell any of your Shares"
        onChange={patch("saleCliffDays")}
        testId="contributor-sale-cliff"
        value={value("saleCliffDays", SALE_DEFAULTS.cliffDays)}
      />
      <TextField
        error={errorFor("saleDays")}
        hint="After that wait, your starting Shares unlock evenly over this many days."
        inputMode="numeric"
        label="Days over which your Shares unlock"
        onChange={patch("saleDays")}
        testId="contributor-sale-days"
        value={value("saleDays", SALE_DEFAULTS.days)}
      />
    </fieldset>
  );
}
