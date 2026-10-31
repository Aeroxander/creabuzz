/**
 * Ways to help: the work areas open for submissions now, as cards. Each says what finished work looks like (verified
 * against the chain), how many Shares it can still award with a bar for how much it already did, who manages it and
 * until when, and has one button that opens the submit form filled in for it; under it, anything else about the area
 * (money people put behind it and forecasts on it). Built on what earns Shares (`lib/ways-to-help.ts`); the areas not
 * taking work are listed under their budget, and suggesting new work is the next card down.
 */

import { ShortName } from "./ShortName";
import { Award, CalendarClock, Coins } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { Meter } from "@/shared/ui/meter";

import { formatUnits } from "../lib/dao-actions";
import type { OpenWorkArea } from "../lib/ways-to-help";
import { Person } from "./Face";

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const whole = (wei: bigint) => formatUnits(wei, 18, 0);

export function WaysToHelp({
  areas,
  labelOf,
  money,
  onPick,
  extra,
  truncated = false,
}: {
  areas: readonly OpenWorkArea[];
  /** The work read was cut short: "none open" is then only what was read. */
  truncated?: boolean;
  labelOf: (address: string) => string;
  /** How a work area's money left is written, in its budget's currency. */
  money: (area: OpenWorkArea) => string;
  /** Open the submit form for this work area. */
  onPick: (area: OpenWorkArea) => void;
  /** More about one area, shown at the bottom of its card (money behind it, forecasts); null for nothing. */
  extra?: (area: OpenWorkArea) => ReactNode;
}) {
  return (
    <Card className="p-4" data-testid="ways-to-help">
      <h3 className="text-base font-semibold">Open work</h3>
      {areas.length === 0 ? (
        <p
          className="mt-2 text-sm text-muted-foreground"
          data-testid="ways-to-help-none"
        >
          {truncated
            ? "No open work was found in the work this page could read (the newest is read). Suggest work below, or ask the team on the Discussion tab what would help."
            : "Nothing is open right now. Suggest work below, or ask the team on the Discussion tab what would help."}
        </p>
      ) : (
        <ul
          className="mt-3 grid gap-3 md:grid-cols-2"
          data-testid="work-projects"
        >
          {areas.map((area) => (
            <li
              // Money behind an area (or the form to put some there) takes the full width, so its forecast has room.
              className="flex flex-col gap-2 rounded-xl border border-border/60 p-3 md:has-[[data-testid=work-bounty-form]]:col-span-2 md:has-[[data-testid=work-bounty]]:col-span-2"
              data-area={area.name}
              data-testid="way-to-help"
              key={`${area.mandate}:${area.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                {/* The short name is what a submission names: quietly beside the title. */}
                <span className="font-semibold">
                  {area.title}
                  <ShortName
                    name={area.title !== area.name ? area.name : null}
                  />
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {area.sharesLeft > 0n ? (
                    <Chip icon={Award} tone="success">
                      {whole(area.sharesLeft)} Shares left
                    </Chip>
                  ) : null}
                  {area.moneyLeft > 0n ? (
                    <Chip icon={Coins} tone="success">
                      {money(area)} left
                    </Chip>
                  ) : null}
                </span>
              </div>
              {area.shareBudget > 0n ? (
                <div>
                  <Meter
                    label={`${area.title}: Shares awarded`}
                    max={area.shareBudget}
                    value={area.sharesAwarded}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {area.sharesAwarded > 0n
                      ? `${whole(area.sharesAwarded)} of ${whole(area.shareBudget)} awarded`
                      : "Nothing awarded yet."}
                  </p>
                </div>
              ) : null}
              {area.words ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    Done when
                  </p>
                  <p className="text-sm" data-testid="way-to-help-words">
                    {area.words}
                  </p>
                </div>
              ) : (
                <p
                  className="text-sm text-amber-700 dark:text-amber-300"
                  data-testid="way-to-help-no-words"
                >
                  Its exact words are not published here. Ask its manager for
                  them before you submit: work that does not state them cannot
                  be accepted for review.
                </p>
              )}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Person label={labelOf(area.manager)} />
                  <Chip icon={CalendarClock}>Until {day(area.expiresAt)}</Chip>
                </span>
                <Button
                  data-testid="way-to-help-submit"
                  onClick={() => onPick(area)}
                  size="sm"
                  type="button"
                >
                  Submit work
                </Button>
              </div>
              {extra ? (
                <div className="border-t border-border/60 pt-2 empty:hidden">
                  {extra(area)}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
