/**
 * The Projects scoreboard: who is moving, who is new, who keeps their promises, who is asking for help. One row per
 * project and one tap per row. The score is weeks in a row, promises kept and open requests, never a price; a price
 * or "Back this project" can sit at the row's right end later without changing its shape.
 */

import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProjectMark } from "@/features/feed/ui/MovingNow";
import { type Launch, launchCoordinate } from "@/features/launchpad/models";
import { Button } from "@/shared/ui/button";

import {
  BOARD_TABS,
  type BoardTab,
  boardOrder,
  keptWords,
  streakWords,
} from "../lib/leaderboard";
import { useLeaderboard } from "../use-leaderboard";

/** Rows a tab shows before "Show more". */
const ROWS = 10;

const EMPTY: Record<BoardTab, string> = {
  moving: "No project has posted this week yet.",
  new: "No projects yet.",
  kept: "No project has kept a promise yet. The first weekly update that answers one puts it here.",
  help: "No project is asking for help right now.",
};

export function ProjectBoard({ launches }: { launches: readonly Launch[] }) {
  const board = useLeaderboard(launches);
  const [tab, setTab] = useState<BoardTab>("moving");
  const [shown, setShown] = useState(ROWS);
  const byCoordinate = useMemo(
    () =>
      new Map(
        launches.map((l) => [
          launchCoordinate(l.record.author, l.record.id),
          l.record,
        ]),
      ),
    [launches],
  );
  const rows = useMemo(
    () => (board.scores ? boardOrder(board.scores, tab) : []),
    [board.scores, tab],
  );
  if (launches.length === 0) return null;
  return (
    <section
      aria-labelledby="project-board-title"
      className="flex flex-col gap-3"
      data-testid="project-board"
    >
      <h2 className="text-base font-semibold" id="project-board-title">
        Scoreboard
      </h2>
      <div
        aria-label="Order projects by"
        className="flex flex-wrap gap-2"
        role="tablist"
      >
        {BOARD_TABS.map((entry) => (
          <button
            aria-selected={tab === entry.id}
            className={`rounded-full px-3 py-1 text-sm font-semibold max-sm:min-h-11 ${
              tab === entry.id
                ? "bg-primary text-primary-foreground"
                : "bg-foreground/[0.07] text-foreground/80 hover:bg-foreground/10"
            }`}
            data-testid={`project-board-tab-${entry.id}`}
            key={entry.id}
            onClick={() => {
              setTab(entry.id);
              setShown(ROWS);
            }}
            role="tab"
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>
      {board.failed ? (
        <p className="text-sm" data-testid="project-board-failed" role="alert">
          Couldn't load the scores.{" "}
          <Button
            onClick={board.retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </p>
      ) : board.scores === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          Adding up the scores…
        </p>
      ) : rows.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="project-board-empty"
        >
          {EMPTY[tab]}
        </p>
      ) : (
        <ol className="flex flex-col gap-2" data-testid="project-board-rows">
          {rows.slice(0, shown).map((score, index) => {
            const record = byCoordinate.get(score.coordinate);
            if (!record) return null;
            const followers = board.followers?.get(score.coordinate);
            const facts = [
              streakWords(score.streak),
              keptWords(score),
              score.openHelp === 0
                ? null
                : score.openHelp === 1
                  ? "1 open request for help"
                  : `${score.openHelp} open requests for help`,
              followers === undefined || followers === 0
                ? null
                : followers === 1
                  ? "1 follower"
                  : `${followers} followers`,
            ].filter((fact): fact is string => fact !== null);
            return (
              <li data-testid="project-board-row" key={score.coordinate}>
                <Link
                  className="glass flex items-center gap-3 rounded-2xl border p-3 transition-colors hover:border-primary/60"
                  params={{ launchId: record.id }}
                  search={{ author: record.author }}
                  to="/launchpad/$launchId"
                >
                  <span
                    aria-hidden
                    className="w-6 shrink-0 text-center text-sm font-black text-muted-foreground"
                  >
                    {index + 1}
                  </span>
                  <ProjectMark image={record.image} name={record.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">
                      {record.name}
                    </span>
                    {record.pitch ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {record.pitch}
                      </span>
                    ) : null}
                    <span
                      className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-medium"
                      data-testid="project-board-facts"
                    >
                      {facts.length > 0
                        ? facts.map((fact) => <span key={fact}>{fact}</span>)
                        : "No updates yet"}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > shown ? (
        <div>
          <Button
            onClick={() => setShown((n) => n + ROWS)}
            size="sm"
            type="button"
            variant="outline"
          >
            Show more
          </Button>
        </div>
      ) : null}
      {board.cut ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="project-board-cut"
          role="status"
        >
          These scores come from the newest projects and their newest records,
          so an older week or promise may be missing. A project's own page has
          its whole record.
        </p>
      ) : null}
    </section>
  );
}
