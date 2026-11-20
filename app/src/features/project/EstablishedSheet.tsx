/**
 * What "Established" means: the three things the server checks, each said in words with a tick or a dash that is also in
 * words, read from the record's own rule and inputs (nothing is typed here). It opens from the chip and, for a project that
 * is not there yet, from Details, so a young project is told what is missing and never shamed.
 */
import { Check, Minus } from "lucide-react";
import { Sheet } from "../../ui/sheet";
import { BannerText } from "../../app/MoneyBanner";
import type { ProjectNumbers } from "../money/numbers";
import {
  ESTABLISHED_HINT,
  ESTABLISHED_SHEET_TITLE,
  ESTABLISHED_UNKNOWN,
  ESTABLISHED_UNTOLD,
  establishedRows,
} from "./project-top-words";

export function EstablishedSheet({
  numbers,
  open,
  onOpenChange,
}: {
  numbers: ProjectNumbers;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rows = establishedRows(numbers);
  return (
    <Sheet
      onOpenChange={onOpenChange}
      open={open}
      testId="established-sheet"
      title={ESTABLISHED_SHEET_TITLE}
    >
      <p className="text-sm">{ESTABLISHED_HINT}</p>
      {rows ? (
        <ul className="flex flex-col gap-2" data-testid="established-rows">
          {rows.map((row) => (
            <li className="flex items-start gap-2.5 text-sm" key={row.text}>
              {row.met ? (
                <Check
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-mint-ink"
                  size={16}
                />
              ) : (
                <Minus
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-muted"
                  size={16}
                />
              )}
              <span>{row.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm" data-testid="established-untold">
          {numbers.established === undefined
            ? ESTABLISHED_UNTOLD
            : ESTABLISHED_UNKNOWN}
        </p>
      )}
      <BannerText testId="sheet-banner" />
    </Sheet>
  );
}
