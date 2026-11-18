/**
 * "Moving now": a strip of the projects with the most real activity this week, at the top of Home. One tap opens a
 * project. The order is days the team posted on (`lib/moving.ts`), never when a record was saved, and never a price.
 *
 * Each card is name, one line and a reason to look. A price or "Back this project" line can sit under the reason
 * later without changing the card's shape.
 */

import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { listedProject } from "@/features/launchpad/lib/listing";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { effectiveStage } from "@/features/launchpad/models";
import { useLaunches } from "@/features/launchpad/use-launches";
import { Button } from "@/shared/ui/button";

import { movingLine, movingNow } from "../lib/moving";

/** A project's mark until it has a picture: its first letter, on a colour of its own. */
export function ProjectMark({
  name,
  image,
  className = "h-9 w-9 text-sm",
}: {
  name: string;
  image?: string | null;
  className?: string;
}) {
  return image ? (
    <img
      alt=""
      className={`shrink-0 rounded-xl object-cover ${className}`}
      src={image}
    />
  ) : (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-xl bg-primary/15 font-black text-primary-ink ${className}`}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function MovingNow() {
  const launches = useLaunches();
  const moving = useMemo(() => {
    const raises = raisesOffered();
    return movingNow(
      (launches.data ?? []).filter((l) =>
        listedProject(l.record, effectiveStage(l), raises),
      ),
      Math.floor(Date.now() / 1000),
    );
  }, [launches.data]);
  if (launches.isError && !launches.data)
    return (
      <p className="text-sm" data-testid="moving-now-failed" role="alert">
        Couldn't load which projects are moving.{" "}
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
  if (moving.length === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  return (
    <section aria-labelledby="moving-now-title" data-testid="moving-now">
      <h2 className="text-sm font-bold" id="moving-now-title">
        Moving now
      </h2>
      <ul className="-mx-1 mt-2 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
        {moving.map(({ launch, days, lastAt }) => (
          <li
            className="w-72 shrink-0 snap-start"
            data-testid="moving-now-item"
            key={`${launch.record.author}:${launch.record.id}`}
          >
            <Link
              className="glass flex h-full items-center gap-3 rounded-2xl border p-3 transition-colors hover:border-primary/60"
              params={{ launchId: launch.record.id }}
              search={{ author: launch.record.author }}
              to="/launchpad/$launchId"
            >
              <ProjectMark
                image={launch.record.image}
                name={launch.record.name}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold">
                  {launch.record.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {movingLine({ days, lastAt }, now)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {launches.newsCut || launches.hasMore ? (
        <p className="text-xs text-muted-foreground" role="status">
          From the newest projects and their newest news.
        </p>
      ) : null}
    </section>
  );
}
