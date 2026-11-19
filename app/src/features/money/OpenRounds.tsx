import { Link } from "@tanstack/react-router";
import { Card } from "../../ui/card";
import { type Project, projectRef } from "../project/project-record";
import { priceLine } from "./MoneyTab";
import { dollarsText, openRound, timeText } from "./numbers-v1";
import { matchNumbers, useRecentNumbers } from "./use-money-v1";

/**
 * Home's open rounds: the projects whose backing round is open now, the one closing soonest first. Never ordered by
 * money. Only projects whose own record names their launch are shown.
 */
export function OpenRounds({ projects }: { projects: readonly Project[] }) {
  const recent = useRecentNumbers();
  const now = Math.floor(Date.now() / 1000);
  if (recent.isPending && recent.fetchStatus !== "idle")
    return <Card className="h-20 animate-pulse" />;
  const open = matchNumbers(projects, recent.data?.events ?? [])
    .map(({ project, numbers }) => ({
      project,
      round: openRound(numbers, now),
    }))
    .filter(
      (
        item,
      ): item is { project: Project; round: NonNullable<typeof item.round> } =>
        item.round !== null,
    )
    .sort((a, b) => a.round.closesAt - b.round.closesAt);
  if (recent.isError)
    return (
      <p className="px-1 text-sm text-muted">
        Open rounds could not be read just now.
      </p>
    );
  if (open.length === 0)
    return (
      <p className="px-1 text-sm text-muted" data-testid="rounds-none">
        {recent.data?.complete === false
          ? "No round is open among the newest projects."
          : "No round is open right now."}
      </p>
    );
  return (
    <>
      {open.map(({ project, round }) => (
        <Link
          className="glass glass-text flex flex-col gap-1.5 rounded-2xl p-4 transition-[filter] hover:brightness-110"
          data-testid="open-round"
          key={project.coordinate}
          params={{ ref: projectRef(project) }}
          to="/p/$ref"
        >
          <h3 className="headline text-xl">{project.name}</h3>
          <p className="text-sm">
            Round {round.round} open until {timeText(round.closesAt)}
          </p>
          <p className="text-xs text-muted">
            {priceLine(round)}. {dollarsText(round.size)} dollars in this round.
          </p>
        </Link>
      ))}
    </>
  );
}
