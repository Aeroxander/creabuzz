/**
 * "Money that stayed" on Home (plan section 7.4): the projects whose money has stayed longest in the server's index, with the
 * number of different accounts beside each as a hint. An ordered list, one link per row. Under the heading, once, the line that
 * this can go up or down; under the list, what the ranking is and is not. It is the server's index and the projects' own
 * records: never a price, never the pot, never volume.
 */
import { Link } from "@tanstack/react-router";
import { Card } from "../../ui/card";
import {
  NOT_A_RETURN,
  PLAY_MONEY_WORDS,
  smallDollarsText,
} from "../pot/pot-words";
import { projectRef } from "../project/project-record";
import { peopleCount, windowWords } from "../project/project-top-words";
import { Section } from "./Section";
import type { Ranking, RankedProject } from "./use-ranking";

export const RANKED_TITLE = "Money that stayed";

/** The line of one row: the money that stayed and the people who kept it. */
export function rankedLine(row: RankedProject): string {
  return `${smallDollarsText(row.entry.money)} kept ${windowWords(row.entry.windowSecs)} or more by ${peopleCount(row.entry.accounts)}.`;
}

/** What the ranking is, under the list. It never says the list is complete. */
export function rankedFootnote(windowSecs: number | null): string {
  const window =
    windowSecs === null
      ? "for a long time"
      : `${windowWords(windowSecs)} or more`;
  return `Ranked by the money that has stayed ${window}, with the number of people beside it, among the projects this server has numbers for. It is not a price and not a promise.`;
}

export function rankedEmpty(windowSecs: number | null): string {
  return windowSecs === null
    ? "No project has had money stay in it that long yet."
    : `No project has money that has stayed ${windowWords(windowSecs)} yet.`;
}

function Row({ row }: { row: RankedProject }) {
  return (
    <li>
      <Link
        className="glass glass-text flex flex-col gap-1 rounded-2xl p-4 transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-mint-ink"
        data-testid="ranked-row"
        params={{ ref: projectRef(row.project) }}
        to="/p/$ref"
      >
        <span className="headline text-xl">{row.project.name}</span>
        <span className="text-sm text-muted">{rankedLine(row)}</span>
        {/* The chip is text: the row's link carries the meaning, so it is not a second stop. */}
        {row.entry.reached === true ? (
          <span
            className="w-fit rounded-full bg-mint/20 px-2.5 py-0.5 text-sm font-semibold text-mint-ink"
            data-testid="ranked-established"
          >
            Established
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * The section, or nothing: it is drawn only when the server's index could be read and is not old. A row names the project, never
 * a person.
 */
export function RankedSection({ ranking }: { ranking: Ranking | undefined }) {
  if (ranking?.status !== "ready") return null;
  return (
    <Section testId="home-ranked" title={RANKED_TITLE}>
      <p className="px-1 text-sm text-muted">{NOT_A_RETURN}</p>
      {ranking.rows.length === 0 ? (
        <Card data-testid="ranked-empty" tone="plain">
          <p className="text-sm">{rankedEmpty(ranking.windowSecs)}</p>
        </Card>
      ) : (
        <ol
          className="m-0 flex list-none flex-col gap-3 p-0"
          data-testid="ranked-list"
        >
          {ranking.rows.map((row) => (
            <Row key={row.project.coordinate} row={row} />
          ))}
        </ol>
      )}
      <p className="px-1 text-sm text-muted" data-testid="ranked-footnote">
        {rankedFootnote(ranking.windowSecs)}
      </p>
      <p className="px-1 text-sm text-muted" data-testid="ranked-play-money">
        {PLAY_MONEY_WORDS}
      </p>
    </Section>
  );
}
