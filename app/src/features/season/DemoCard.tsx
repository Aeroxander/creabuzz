/**
 * One project on demo day (plan section 5.3): its name and line, the project's money, and its last update. Nothing else: no
 * kept line, no streak, no chip (the project's page has them). The only press is "Open project". The card is a region with
 * a heading; the button's label carries the project's name for a screen reader, so two projects are two distinct presses.
 */
import { useId } from "react";
import { ButtonLink } from "../../ui/button";
import { timeText } from "../money/numbers";
import { smallDollarsText } from "../pot/pot-words";
import { projectRef } from "../project/project-record";
import {
  NO_NUMBERS,
  NO_UPDATE,
  OPEN_PROJECT,
  STALE_NUMBERS,
} from "./season-words";
import type { DemoCardData } from "./use-demo-day";

/** What the card says about the project's money, or why it says none. */
function moneyWords(card: DemoCardData): string {
  const { numbers, freshness } = card;
  if (!numbers || !freshness) return NO_NUMBERS;
  // A record older than a day is not shown as a figure: the card says so, as a list anywhere else does.
  if (freshness.level === "stale") return STALE_NUMBERS;
  const money = `The project's money ${smallDollarsText(numbers.money.pot)}`;
  return freshness.level === "as-of"
    ? `${money} (numbers as of ${timeText(numbers.builtAt)})`
    : money;
}

export function DemoCard({ card }: { card: DemoCardData }) {
  const headingId = useId();
  const { project, update } = card;
  return (
    <li>
      <article
        aria-labelledby={headingId}
        className="glass glass-text flex flex-col gap-2 rounded-2xl p-4"
        data-testid="demo-card"
      >
        <h3 className="headline break-words text-xl" id={headingId}>
          {project.name}
        </h3>
        {project.pitch ? (
          <p className="line-clamp-2 break-words text-sm text-muted">
            {project.pitch}
          </p>
        ) : null}
        <p className="text-sm" data-testid="demo-money">
          {moneyWords(card)}
        </p>
        <div
          className="flex flex-col gap-0.5 text-sm"
          data-testid="demo-update"
        >
          {update ? (
            <>
              <p className="text-muted">Last update {timeText(update.at)}</p>
              {update.title ? (
                <p className="break-words font-semibold">{update.title}</p>
              ) : null}
              {update.body ? (
                <p className="break-words text-muted">{update.body}</p>
              ) : null}
            </>
          ) : (
            <p className="text-muted">{NO_UPDATE}</p>
          )}
        </div>
        <ButtonLink
          aria-label={`${OPEN_PROJECT} ${project.name}`}
          data-testid="demo-open"
          params={{ ref: projectRef(project) }}
          size="sm"
          to="/p/$ref"
          variant="secondary"
        >
          {OPEN_PROJECT}
        </ButtonLink>
      </article>
    </li>
  );
}
