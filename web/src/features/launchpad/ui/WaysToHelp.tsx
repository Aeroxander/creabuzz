/**
 * Ways to help: the work areas open for submissions now, each with what finished work looks like (verified against the
 * chain), who manages it and how much it can still award, and one button that opens the submit form filled in for it.
 * Built on what earns Shares (`lib/ways-to-help.ts`); suggesting new work is the next card down.
 */

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { formatUnits } from "../lib/dao-actions";
import type { OpenWorkArea } from "../lib/ways-to-help";

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function WaysToHelp({
  areas,
  labelOf,
  money,
  onPick,
}: {
  areas: readonly OpenWorkArea[];
  labelOf: (address: string) => string;
  /** How a work area's money left is written, in its budget's currency. */
  money: (area: OpenWorkArea) => string;
  /** Open the submit form for this work area. */
  onPick: (area: OpenWorkArea) => void;
}) {
  return (
    <Card className="p-4" data-testid="ways-to-help">
      <h3 className="text-sm font-semibold">Ways to help</h3>
      <p className="text-xs text-muted-foreground">
        Work areas open for submissions. Submit work that meets what finished
        work looks like; once it is reviewed, Shareholders can vote to award
        Shares for it. Approval alone gives none.
      </p>
      {areas.length === 0 ? (
        <p
          className="mt-3 text-sm text-muted-foreground"
          data-testid="ways-to-help-none"
        >
          No work area is open for submissions right now. Suggest work below, or
          ask the team on the Discussion tab what would help.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {areas.map((area) => (
            <li
              className="rounded-lg border p-3"
              data-area={area.name}
              data-testid="way-to-help"
              key={`${area.mandate}:${area.id}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{area.name}</span>
                <span className="text-xs text-muted-foreground">
                  {area.sharesLeft > 0n
                    ? `Up to ${formatUnits(area.sharesLeft, 18)} Shares left`
                    : "No Shares"}
                  {area.moneyLeft > 0n ? ` · ${money(area)} left` : ""} ·
                  managed by {labelOf(area.manager)} · open until{" "}
                  {day(area.expiresAt)}
                </span>
              </div>
              {area.words ? (
                <p className="mt-1 text-sm" data-testid="way-to-help-words">
                  <span className="text-muted-foreground">
                    Finished looks like:{" "}
                  </span>
                  {area.words}
                </p>
              ) : (
                <p
                  className="mt-1 text-sm text-amber-700 dark:text-amber-300"
                  data-testid="way-to-help-no-words"
                >
                  Its exact words are not published here. Ask its manager for
                  them before you submit: work that does not state them cannot
                  be accepted for review.
                </p>
              )}
              <Button
                className="mt-2"
                data-testid="way-to-help-submit"
                onClick={() => onPick(area)}
                size="sm"
                type="button"
                variant="outline"
              >
                Submit work for this
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
