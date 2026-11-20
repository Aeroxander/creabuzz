import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { freshnessOf, type ProjectNumbers } from "../money/numbers";
import type { Project } from "../project/project-record";
import { asOfLine } from "../project/project-top-words";
import {
  FIRST_ITEMS,
  MORE_ITEMS,
  movedHours,
  shownItems,
  signedNet,
} from "./feed-rows";
import {
  backedWords,
  coverWords,
  FEED_EMPTY,
  FEED_TITLE,
  HIDE_BY_THE_HOUR,
  hourLabel,
  itemWords,
  netSentence,
  roundingNote,
  SHOW_BY_THE_HOUR,
  SHOW_EARLIER,
  sumHours,
  tookOutWords,
} from "./feed-words";

/**
 * One count of the feed. A join and a take-out are drawn by this one component with these classes and no others, so neither
 * is bolder, bigger or coloured against the other (a test compares them).
 */
const COUNT_CLASS = "num font-semibold";
function Count({ testId, children }: { testId?: string; children: string }) {
  return (
    <span className={COUNT_CLASS} data-testid={testId}>
      {children}
    </span>
  );
}

/** The two counts in their one fixed order and the same form: "3 backed, 1 took out". */
function Counts({
  joins,
  tookOut,
  testIds,
}: {
  joins: number;
  tookOut: number;
  testIds?: boolean;
}) {
  return (
    <>
      <Count testId={testIds ? "feed-joins" : undefined}>
        {backedWords(joins)}
      </Count>
      {", "}
      <Count testId={testIds ? "feed-took-out" : undefined}>
        {tookOutWords(tookOut)}
      </Count>
    </>
  );
}

/**
 * The live feed ("Lately") under a project's top block (plan section 7.5): the things that lasted (tasks and updates) first,
 * then one line for the last two days of joins and take-outs at equal weight, and the hours behind a press. Everything comes
 * from the signed record's `feed` key: no names, no addresses, amounts rounded by the server, never a volume. A record that
 * has no feed, or one older than a day, draws nothing. It does not repeat "This can go up or down. It is not a return.": that line
 * stands under the money card directly above it, and the feed is drawn only on the page that has the card.
 */
export function ProjectFeed({
  numbers,
}: {
  numbers: ProjectNumbers | null;
  project: Project;
}) {
  const titleId = useId();
  const hoursId = useId();
  const [shown, setShown] = useState(FIRST_ITEMS);
  const [byHour, setByHour] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  // The index of the first item a press of "Show earlier" has just revealed: focus moves there, so the press never loses it.
  const [reveal, setReveal] = useState<number | null>(null);
  useEffect(() => {
    if (reveal === null) return;
    list.current
      ?.querySelectorAll<HTMLElement>("[data-testid='feed-item']")
      [reveal]?.focus();
    setReveal(null);
  }, [reveal]);
  const feed = numbers?.feed;
  if (!numbers || !feed) return null;
  const now = Math.floor(Date.now() / 1000);
  const level = freshnessOf(numbers, now).level;
  // Past a day the record's money is not shown: the feed's amounts are money.
  if (level === "stale") return null;

  const sum = sumHours(feed.hours);
  const items = shownItems(feed.items, shown);
  // Two items alike (the same kind at the same moment) are still two rows: a count after the name keeps their keys apart.
  const count = new Map<string, number>();
  const keyed = items.map((item) => {
    const base = `${item.kind}-${item.at}-${item.serial ?? "x"}`;
    const n = (count.get(base) ?? 0) + 1;
    count.set(base, n);
    return { item, key: `${base}-${n}` };
  });
  const moved = movedHours(feed.hours);
  const empty = feed.items.length === 0 && !sum.moved;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3 p-3"
      data-testid="project-feed"
      role="region"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="headline text-xl" id={titleId}>
          {FEED_TITLE}
        </h2>
        <p className="text-sm text-muted" data-testid="feed-rounding">
          {roundingNote(feed.roundTo)}
        </p>
        {level === "as-of" ? (
          <p className="text-sm text-muted" data-testid="feed-as-of">
            {asOfLine(numbers)}
          </p>
        ) : null}
      </div>

      {empty ? (
        <p className="text-sm" data-testid="feed-empty">
          {FEED_EMPTY}
        </p>
      ) : null}

      {feed.items.length > 0 ? (
        <>
          <ul
            className="flex flex-col gap-2"
            data-testid="feed-items"
            ref={list}
          >
            {keyed.map(({ item, key }) => (
              <li
                className="flex flex-col text-sm focus-visible:outline-2 focus-visible:outline-mint-ink"
                data-testid="feed-item"
                key={key}
                tabIndex={-1}
              >
                <span>{itemWords(item, now)}</span>
                <span className="text-muted">{relativeTime(item.at)}</span>
              </li>
            ))}
          </ul>
          {items.length < feed.items.length ? (
            <Button
              data-testid="feed-show-earlier"
              onClick={() => {
                setReveal(items.length);
                setShown((n) => n + MORE_ITEMS);
              }}
              size="sm"
              variant="secondary"
            >
              {SHOW_EARLIER}
            </Button>
          ) : null}
        </>
      ) : null}

      {sum.moved ? (
        <div className="flex flex-col gap-1" data-testid="feed-lately">
          <p className="text-sm">
            Last {coverWords(feed.hours, feed.bucketSecs)}:{" "}
            <Counts joins={sum.joins} testIds tookOut={sum.tookOut} />.
          </p>
          <p className="text-sm text-muted" data-testid="feed-net">
            {netSentence(sum)}
          </p>
          <Button
            aria-controls={hoursId}
            aria-expanded={byHour}
            data-testid="feed-by-hour"
            onClick={() => setByHour((v) => !v)}
            size="sm"
            variant="secondary"
          >
            {byHour ? HIDE_BY_THE_HOUR : SHOW_BY_THE_HOUR}
          </Button>
          <div hidden={!byHour} id={hoursId}>
            {byHour ? (
              <ul className="flex flex-col gap-2" data-testid="feed-hours">
                {moved.map((h) => (
                  <li
                    className="flex flex-col text-sm"
                    data-testid="feed-hour"
                    key={h.at}
                  >
                    <span>
                      {hourLabel(h)}:{" "}
                      <Counts joins={h.joins} tookOut={h.tookOut} />.
                    </span>
                    <span className="text-muted">
                      {netSentence({
                        joins: h.joins,
                        tookOut: h.tookOut,
                        net: signedNet(h),
                        hidden:
                          h.joins > 0 && h.tookOut > 0 && h.net.dir === "even",
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
