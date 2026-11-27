/**
 * The top of a project's page, in the order of plan section 7.1: what it is, the project's money
 * with "what taking out now would give", the fixed banner, then Back and Share, then who backs it, how long money has stayed
 * and the updates, and one fold of details. On a phone at 360 by 640 the name, the money, the banner and Back are in view
 * without scrolling. Everything money comes from the signed record with its age (a record past a day shows none of it, and
 * says so), and a part the record cannot say is not drawn: never "none" or zero for what is not known.
 */
import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { BannerText, useOwnBanner } from "../../app/MoneyBanner";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { ChunkBoundary } from "../../ui/chunk-boundary";
import { freshnessOf, type ProjectNumbers } from "../money/numbers";
import { StaleMoney } from "../pot/MoneyFacts";
import {
  allowanceWords,
  doorShutWords,
  NOT_A_RETURN,
  PLAY_MONEY_WORDS,
  smallDollarsText,
} from "../pot/pot-words";
import type { Project } from "./project-record";
import {
  asOfLine,
  doorChip,
  keptLine,
  peopleLine,
  takeOutNowLine,
  checkInLine,
} from "./project-top-words";

// The Back box carries the money calls and their contract ABIs: it loads after the page's first paint, as the Money tab did.
const BackSection = lazy(() =>
  import("./BackSection").then((m) => ({ default: m.BackSection })),
);

// The share sheet loads when first opened and then stays mounted.
const ShareSheet = lazy(() =>
  import("./ShareSheet").then((m) => ({ default: m.ShareSheet })),
);

function Header({ project }: { project: Project }) {
  return (
    <header className="flex flex-col gap-3">
      <h1 className="headline text-3xl" data-testid="project-name">
        {project.name}
      </h1>
      {project.pitch ? (
        <p className="line-clamp-2 text-muted">{project.pitch}</p>
      ) : null}
    </header>
  );
}

/** Who started it and when: under the presses on the money page, right under the name on the plain one. */
function StartedBy({
  project,
  founderName,
}: {
  project: Project;
  founderName: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-1 text-sm">
      <Avatar name={founderName} pubkey={project.author} size="sm" />
      <span>
        Started by <span className="font-semibold">{founderName}</span>{" "}
        <span className="text-muted">{relativeTime(project.startedAt)}</span>
      </span>
    </div>
  );
}

/** The project's money and what taking out now would give (rows 3 and 4 of the plan's order). */
function TopMoney({
  numbers,
  now,
  chips,
}: {
  numbers: ProjectNumbers;
  now: number;
  /** The chip (the door), drawn on the card's first line. */
  chips: ReactNode;
}) {
  const level = freshnessOf(numbers, now).level;
  if (level === "stale")
    return <StaleMoney numbers={numbers} testId="top-money-stale" />;
  return (
    <div
      className="glass flex flex-col gap-0.5 rounded-2xl p-3"
      data-testid="top-money"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">The project's money</p>
        {chips}
      </div>
      <p className="num headline text-2xl" data-testid="top-money-pot">
        {smallDollarsText(numbers.money.pot)}
      </p>
      <p className="text-sm text-muted">{NOT_A_RETURN}</p>
      <p className="text-sm" data-testid="top-take-out-now">
        {takeOutNowLine(numbers)}
      </p>
      {level === "as-of" ? (
        <p className="text-sm text-muted" data-testid="top-as-of">
          {asOfLine(numbers)}
        </p>
      ) : null}
      {mustSayPlayMoney(numbers.playMoney) ? (
        <p className="pt-1 text-sm text-muted" data-testid="top-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
    </div>
  );
}

/** Who backs it, how long money has stayed and the check-ins (rows 7 to 9). */
function TopFacts({ numbers, now }: { numbers: ProjectNumbers; now: number }) {
  const level = freshnessOf(numbers, now).level;
  // Money figures hide with a record past a day; the check-ins are not money and stay, with their age.
  const kept = level === "stale" ? null : keptLine(numbers);
  const checkIn = checkInLine(numbers, relativeTime);
  return (
    <ul className="flex flex-col gap-1.5 px-1 text-sm" data-testid="top-facts">
      {level === "stale" ? null : (
        <li data-testid="top-people">{peopleLine(numbers.holderCount)}</li>
      )}
      {kept ? <li data-testid="top-kept">{kept}</li> : null}
      <li data-testid="top-check-in">
        {checkIn}
        {level === "fresh" ? "" : ` (${asOfLine(numbers)})`}
      </li>
    </ul>
  );
}

function Details({ numbers, now }: { numbers: ProjectNumbers; now: number }) {
  const fresh = freshnessOf(numbers, now).level !== "stale";
  const shut = doorShutWords(numbers, now);
  return (
    <details
      className="glass rounded-2xl px-4 py-1"
      data-testid="project-details"
    >
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
        Details
      </summary>
      <div className="flex flex-col gap-3 pb-3 text-sm">
        <p className="text-muted">{asOfLine(numbers)}</p>
        {fresh ? (
          <p data-testid="top-allowance">{allowanceWords(numbers)}</p>
        ) : null}
        {shut ? <p data-testid="top-door-shut">{shut}</p> : null}
      </div>
    </details>
  );
}

export function ProjectTop({
  project,
  numbers,
  now,
  investing,
  founderName,
}: {
  project: Project;
  /** The project's numbers; null while they are read, when there are none, or when investing is off. */
  numbers: ProjectNumbers | null;
  now: number;
  /** Whether the server offers investing: everything below the header is drawn only then. */
  investing: boolean;
  founderName: string;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [shareSeen, setShareSeen] = useState(false);
  const openShare = () => {
    setShareSeen(true);
    setShareOpen(true);
  };
  // The page draws its own banner (below), so the shell does not draw a second one.
  useOwnBanner(investing);
  const fresh = numbers ? freshnessOf(numbers, now).level !== "stale" : false;
  return (
    <div className="flex flex-col gap-3" data-testid="project-top">
      <Header project={project} />
      {investing ? null : (
        <StartedBy founderName={founderName} project={project} />
      )}
      {investing ? (
        <>
          {numbers ? (
            <TopMoney
              chips={
                fresh ? (
                  <div
                    className="flex flex-wrap items-center justify-end gap-2"
                    data-testid="top-chips"
                  >
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-sm">
                      {doorChip(numbers, now)}
                    </span>
                  </div>
                ) : null
              }
              now={now}
              numbers={numbers}
            />
          ) : null}
          {/* Without a record the page still says it is play money. */}
          {numbers ? null : (
            <p className="text-sm text-muted" data-testid="top-play-money">
              {PLAY_MONEY_WORDS}
            </p>
          )}
          <Card className="p-3" data-testid="top-banner">
            <BannerText className="text-sm" />
          </Card>
          <div className="flex flex-col gap-3" data-testid="top-presses">
            {numbers ? (
              <ChunkBoundary>
                <Suspense fallback={<Card className="h-40 animate-pulse" />}>
                  <BackSection
                    now={now}
                    numbers={numbers}
                    projectName={project.name}
                  />
                </Suspense>
              </ChunkBoundary>
            ) : null}
            <Button
              data-testid="share-open"
              onClick={openShare}
              variant="secondary"
            >
              Share
            </Button>
          </div>
          <StartedBy founderName={founderName} project={project} />
          {numbers ? <TopFacts now={now} numbers={numbers} /> : null}
          {numbers ? <Details now={now} numbers={numbers} /> : null}
          <ChunkBoundary quiet>
            <Suspense fallback={null}>
              {shareSeen ? (
                <ShareSheet
                  onOpenChange={setShareOpen}
                  open={shareOpen}
                  project={project}
                />
              ) : null}
            </Suspense>
          </ChunkBoundary>
        </>
      ) : null}
    </div>
  );
}
