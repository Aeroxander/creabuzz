/**
 * The newcomer's welcome on Home: three ways in, shown once to an account tied to no project yet (`lib/welcome.ts`).
 * "Just follow some projects" opens up to five active projects, each with Follow. Choosing a way in or "Not now"
 * puts it away for good; until then Home's usual next step waits behind it.
 */

import { Link } from "@tanstack/react-router";
import { Hammer, Rocket, Star } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { listedProject } from "@/features/launchpad/lib/listing";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { effectiveStage, launchCoordinate } from "@/features/launchpad/models";
import { useLaunches } from "@/features/launchpad/use-launches";
import { useMyNeeds } from "@/features/launchpad/use-my-projects";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";

import { markWelcomeSeen, welcomePicks, welcomeSeen } from "../lib/welcome";
import { FollowButton } from "./FollowButton";
import { readerScrolled } from "./HomeNextStep";
import { ProjectMark } from "./MovingNow";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const CHOICE_CLASS =
  "glass flex min-w-0 flex-1 basis-40 flex-col items-start gap-1 rounded-2xl border p-3 text-left transition-colors hover:border-primary/60";

function FollowSome({ me }: { me: string }) {
  const launches = useLaunches();
  const picks = useMemo(() => {
    const raises = raisesOffered();
    return welcomePicks(
      (launches.data ?? []).filter((l) =>
        listedProject(l.record, effectiveStage(l), raises),
      ),
      Math.floor(Date.now() / 1000),
      me,
    );
  }, [launches.data, me]);
  if (launches.isError && !launches.data)
    return (
      <p className="text-sm" data-testid="welcome-follow-failed" role="alert">
        Couldn't load projects to follow.{" "}
        <Button
          onClick={() => void launches.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </p>
    );
  if (launches.isLoading)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Finding active projects…
      </p>
    );
  if (picks.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="welcome-none">
        No projects to follow yet. Yours could be the first.
      </p>
    );
  return (
    <ul className="flex flex-col gap-2" data-testid="welcome-follow-list">
      {picks.map(({ record }) => (
        <li
          className="flex items-center gap-3"
          data-testid="welcome-follow-item"
          key={`${record.author}:${record.id}`}
        >
          <ProjectMark image={record.image} name={record.name} />
          <span className="min-w-0 flex-1">
            <Link
              className="block truncate text-sm font-bold hover:underline"
              params={{ launchId: record.id }}
              search={{ author: record.author }}
              to="/launchpad/$launchId"
            >
              {record.name}
            </Link>
            {record.pitch ? (
              <span className="block truncate text-xs text-muted-foreground">
                {record.pitch}
              </span>
            ) : null}
          </span>
          <FollowButton
            label={record.name}
            launchCoord={launchCoordinate(record.author, record.id)}
            testId="welcome-follow"
          />
        </li>
      ))}
    </ul>
  );
}

/** Home's top line for a signed-in person: the welcome while it applies, otherwise `children` (the next step). */
export function NewcomerWelcome({
  me,
  children,
}: {
  me: string;
  children: ReactNode;
}) {
  const server = relayWsUrl();
  const [seen, setSeen] = useState(() => welcomeSeen(storage(), server, me));
  const [following, setFollowing] = useState(false);
  const mine = useMyNeeds();
  // Settled once per visit, when the facts first answer: a welcome must not appear, or vanish, under a reader.
  const applies = useRef<boolean | null>(null);
  if (!seen && applies.current === null && mine.ready && !mine.failed)
    applies.current = mine.noProject && !readerScrolled();
  if (seen || applies.current !== true) return <>{children}</>;
  const done = () => {
    markWelcomeSeen(storage(), server, me);
    setSeen(true);
  };
  return (
    <section
      aria-labelledby="welcome-title"
      className="glass flex flex-col gap-3 rounded-2xl border p-4"
      data-testid="newcomer-welcome"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold" id="welcome-title">
            Welcome. What brings you here?
          </h2>
          <p className="text-sm text-muted-foreground">
            Pick one to begin. You can do the others any time.
          </p>
        </div>
        <Button
          aria-label="Not now: close this welcome"
          data-testid="welcome-dismiss"
          onClick={done}
          size="sm"
          type="button"
          variant="ghost"
        >
          Not now
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link
          className={CHOICE_CLASS}
          data-testid="welcome-start"
          onClick={done}
          to="/start"
        >
          <Rocket aria-hidden className="h-5 w-5 text-primary" />
          <span className="text-sm font-bold">Start a project</span>
          <span className="text-xs text-muted-foreground">
            Four answers and it's live.
          </span>
        </Link>
        <Link
          className={CHOICE_CLASS}
          data-testid="welcome-work"
          onClick={done}
          to="/work"
        >
          <Hammer aria-hidden className="h-5 w-5 text-primary" />
          <span className="text-sm font-bold">Find work</span>
          <span className="text-xs text-muted-foreground">
            Help a real project and build your record.
          </span>
        </Link>
        <button
          aria-expanded={following}
          className={CHOICE_CLASS}
          data-testid="welcome-follow-some"
          onClick={() => setFollowing((was) => !was)}
          type="button"
        >
          <Star aria-hidden className="h-5 w-5 text-primary" />
          <span className="text-sm font-bold">Just follow some projects</span>
          <span className="text-xs text-muted-foreground">
            See what they ship, week by week.
          </span>
        </button>
      </div>
      {following ? (
        <div className="flex flex-col gap-3">
          <FollowSome me={me} />
          <div>
            <Button
              data-testid="welcome-done"
              onClick={done}
              size="sm"
              type="button"
            >
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
