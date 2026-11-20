/**
 * The season band on Home (plan section 5.3): one card under the welcome, from the newest season record and the clock. It says
 * where the season stands; before demo day a founder or a team member can enter a project, or take it out; on and after demo
 * day it links to the page that shows the projects together. With no season record the band is not drawn, and it is drawn
 * only where the server turns investing on.
 */
import { useId, useState } from "react";
import { useAccount } from "../../lib/account";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import type { Project } from "../project/project-record";
import {
  type Phase,
  currentSeason,
  liveCoordinates,
  type Season,
} from "./season-records";
import {
  BAND_TITLE,
  bandWords,
  ENTERED,
  enterWords,
  isInWords,
  LEAVE,
  LEFT,
  SEE_DEMO_DAY,
  SEE_THAT_DEMO_DAY,
  seasonRefusal,
} from "./season-words";
import {
  projectsIn,
  useMyProjects,
  useSeasonEntries,
  useSeasons,
  useSeasonStep,
} from "./use-season";

/** The most of a person's projects the band offers at once (a person with more is rare; the band stays one short card). */
const MOST_PROJECTS = 5;

export function SeasonBand() {
  const seasons = useSeasons();
  // Where the server does not offer investing the read is not made (`useSeasons`), so there is nothing to draw.
  if (!seasons.data) return null;
  const now = Math.floor(Date.now() / 1000);
  const current = currentSeason(seasons.data, now);
  if (!current) return null;
  return <Band phase={current.phase} season={current.season} />;
}

function Band({ season, phase }: { season: Season; phase: Phase }) {
  const { pubkey } = useAccount();
  const headingId = useId();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const open = phase === "open";
  // The entries are read only where they are shown: the count on demo day, and which of a person's projects are in.
  const entries = useSeasonEntries(
    season.number,
    phase === "demo" || (open && pubkey !== null),
  );
  const mine = useMyProjects(pubkey, open);
  const step = useSeasonStep(season.number);
  const live = new Set(
    entries.data ? liveCoordinates(entries.data.entries) : [],
  );
  // A season with more entries than can be read at once gives no count rather than a wrong one.
  const count = entries.data?.trimmed ? null : projectsIn(entries.data);
  const projects = (mine.data ?? []).slice(0, MOST_PROJECTS);

  const change = (project: Project, which: "entry" | "leave") => {
    setProblem(null);
    step.mutate(
      { coordinate: project.coordinate, step: which },
      {
        onSuccess: () =>
          toast(
            which === "entry" ? ENTERED(project.name) : LEFT(project.name),
            "done",
          ),
        onError: (error) =>
          setProblem(
            seasonRefusal(error, which === "entry" ? "enter" : "leave"),
          ),
      },
    );
  };

  return (
    <Card
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      data-testid="season-band"
      role="region"
    >
      <h2 className="font-semibold" id={headingId}>
        {BAND_TITLE}
      </h2>
      <p className="text-sm" data-testid="season-band-words">
        {bandWords(season, phase, count)}
      </p>
      {open && entries.data && projects.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {projects.map((project) => {
            const isIn = live.has(project.coordinate);
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid="season-project"
                key={project.coordinate}
              >
                {isIn ? (
                  <>
                    <span className="min-w-0 break-words text-sm">
                      {isInWords(project.name)}
                    </span>
                    <Button
                      aria-label={`${LEAVE} ${project.name}`}
                      disabled={step.isPending}
                      onClick={() => change(project, "leave")}
                      size="sm"
                      variant="secondary"
                    >
                      {LEAVE}
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={step.isPending}
                    onClick={() => change(project, "entry")}
                    size="sm"
                    variant="secondary"
                  >
                    {enterWords(project.name)}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid="season-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {phase === "demo" || phase === "ended" ? (
        <ButtonLink
          data-testid="season-demo-link"
          params={{ n: String(season.number) }}
          size="sm"
          to="/season/$n"
          variant="secondary"
        >
          {phase === "demo" ? SEE_DEMO_DAY : SEE_THAT_DEMO_DAY}
        </ButtonLink>
      ) : null}
    </Card>
  );
}
