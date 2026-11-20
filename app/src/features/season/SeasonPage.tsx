/**
 * A season's page (`/season/<n>`, plan section 5.3): the season's number and dates, and the projects that entered and were not
 * removed, together, each with its money and its last update. The order is the same for everyone and is never money, a price or
 * the time of entry (`season-order.ts`); 24 are drawn at a time. The page is read-only: its one press on a card is "Open
 * project". It draws its own banner (the shell's steps aside), and carries the line that money can go up or down once under
 * the list's heading.
 */
import { useId, useMemo, useState } from "react";
import { BackHeader } from "../../app/BackHeader";
import { BannerText, useOwnBanner } from "../../app/MoneyBanner";
import { investingOn } from "../../lib/server";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { NOT_A_RETURN, PLAY_MONEY_WORDS } from "../pot/pot-words";
import { DemoCard } from "./DemoCard";
import { inSeasonOrder } from "./season-order";
import {
  candidateCoordinates,
  phaseOf,
  type SeasonEntry,
} from "./season-records";
import {
  bandWords,
  datesWords,
  DEMO_EMPTY,
  DEMO_LIST_TITLE,
  DEMO_NOT_FOUND,
  DEMO_TRIM,
  DEMO_UNREAD,
  NOT_ADVICE,
  SHOW_MORE,
  TRY_AGAIN,
} from "./season-words";
import { BATCH_SIZE, useDemoBatch } from "./use-demo-day";
import { projectsIn, useSeasonEntries, useSeasons } from "./use-season";

/** One batch of cards: its own read, so "Show more" reads only the next 24. */
function Batch({
  number,
  index,
  coordinates,
  entries,
}: {
  number: number;
  index: number;
  coordinates: readonly string[];
  entries: readonly SeasonEntry[];
}) {
  const batch = useDemoBatch(number, index, coordinates, entries);
  if (batch.isPending)
    return (
      <li>
        <Card className="h-28 animate-pulse" />
      </li>
    );
  if (batch.isError)
    return (
      <li>
        <Card className="flex flex-col gap-2" data-testid="demo-batch-failed">
          <p className="text-sm">{DEMO_UNREAD}</p>
          <Button
            onClick={() => void batch.refetch()}
            size="sm"
            variant="secondary"
          >
            {TRY_AGAIN}
          </Button>
        </Card>
      </li>
    );
  return (
    <>
      {batch.data.map((card) => (
        <DemoCard card={card} key={card.project.coordinate} />
      ))}
    </>
  );
}

export function SeasonPage({ number }: { number: number }) {
  useOwnBanner();
  const listId = useId();
  const seasons = useSeasons();
  // Season 0 is no season (an address that is not a number): nothing is read for it, and the page says so.
  const entries = useSeasonEntries(number, number > 0);
  const [batches, setBatches] = useState(1);
  const season = seasons.data?.find((s) => s.number === number) ?? null;
  const ordered = useMemo(
    () =>
      entries.data
        ? inSeasonOrder(number, candidateCoordinates(entries.data.entries))
        : [],
    [entries.data, number],
  );
  const shown = ordered.slice(0, batches * BATCH_SIZE);
  const now = Math.floor(Date.now() / 1000);

  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="season-page"
    >
      <BackHeader title={`Season ${number}`} />
      {!investingOn() ? (
        <EmptyState title="Seasons are not shown here">
          This server does not show seasons.
        </EmptyState>
      ) : number === 0 ? (
        <EmptyState title={DEMO_NOT_FOUND} />
      ) : seasons.isPending || entries.isPending ? (
        <Card className="h-28 animate-pulse" />
      ) : seasons.isError || entries.isError ? (
        <EmptyState
          action={
            <Button
              onClick={() => {
                void seasons.refetch();
                void entries.refetch();
              }}
              variant="secondary"
            >
              {TRY_AGAIN}
            </Button>
          }
          title={DEMO_UNREAD}
        />
      ) : !season ? (
        <EmptyState title={DEMO_NOT_FOUND} />
      ) : (
        <>
          <div className="flex flex-col gap-1 px-1">
            <p className="text-sm" data-testid="season-dates">
              {datesWords(season)}
            </p>
            <p className="text-sm text-muted" data-testid="season-phase">
              {bandWords(
                season,
                phaseOf(season, now),
                entries.data.trimmed ? null : projectsIn(entries.data),
              )}
            </p>
          </div>
          <section
            aria-labelledby={listId}
            className="flex flex-col gap-3"
            data-testid="demo-list"
          >
            <h2
              className="text-sm font-semibold uppercase tracking-wider text-muted"
              id={listId}
            >
              {DEMO_LIST_TITLE}
            </h2>
            <p className="px-1 text-sm text-muted">{NOT_A_RETURN}</p>
            {ordered.length === 0 ? (
              <Card data-testid="demo-empty" tone="plain">
                <p className="text-sm">{DEMO_EMPTY}</p>
              </Card>
            ) : (
              <ol
                className="m-0 flex list-none flex-col gap-3 p-0"
                data-testid="demo-cards"
              >
                {Array.from({ length: batches }, (_, index) => {
                  const slice = ordered.slice(
                    index * BATCH_SIZE,
                    (index + 1) * BATCH_SIZE,
                  );
                  return slice.length === 0 ? null : (
                    <Batch
                      coordinates={slice}
                      entries={entries.data.entries}
                      index={index}
                      key={slice[0]}
                      number={number}
                    />
                  );
                })}
              </ol>
            )}
            {shown.length < ordered.length ? (
              <Button
                data-testid="demo-more"
                onClick={() => setBatches((n) => n + 1)}
                variant="secondary"
              >
                {SHOW_MORE}
              </Button>
            ) : null}
            {entries.data.trimmed ? (
              <p className="px-1 text-sm text-muted" data-testid="demo-trim">
                {DEMO_TRIM}
              </p>
            ) : null}
          </section>
          <BannerText />
          <p className="text-sm text-muted" data-testid="demo-play-money">
            {PLAY_MONEY_WORDS}
          </p>
          <p className="text-sm text-muted" data-testid="demo-not-advice">
            {NOT_ADVICE}
          </p>
        </>
      )}
    </main>
  );
}
