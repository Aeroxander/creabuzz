/**
 * What is yours, and what is waiting on you, at the top of Home.
 *
 * Home used to open on a feed no matter who you were. Someone who runs a project needs the opposite: their own
 * organizations one click away, and anything that is waiting for their answer in front of them. Both are read from
 * what the app already loads (your launches, the approval requests addressed to you), so nothing here is a second
 * source of truth. It shows nothing at all until there is something to show.
 */

import { Link } from "@tanstack/react-router";

import { useLaunches } from "@/features/launchpad/use-launches";
import { isIdea } from "@/features/launchpad/lib/idea";
import { effectiveStage } from "@/features/launchpad/models";
import { StageBadge } from "@/features/launchpad/ui/widgets";
import { ApprovalsPanel } from "@/features/notifications/ui/ApprovalsPanel";

import { WaitingOnYou } from "./WaitingOnYou";

export function HomeYours({ me }: { me: string }) {
  const launches = useLaunches();
  const mine = (launches.data ?? []).filter((l) => l.record.author === me);

  return (
    <>
      <section aria-label="Needs you" data-testid="home-needs-you">
        {/* Renders nothing when no request is waiting. */}
        <ApprovalsPanel />
        {/* What is waiting on you in your DAOs; renders nothing when nothing is. */}
        <WaitingOnYou />
      </section>
      {mine.length > 0 ? (
        <section
          aria-labelledby="home-yours-title"
          className="glass rounded-2xl border p-5"
          data-testid="home-yours"
        >
          <h2 className="text-base font-bold" id="home-yours-title">
            Your organizations
          </h2>
          <ul className="mt-2 divide-y divide-border/60">
            {mine.map((launch) => (
              <li
                className="flex items-center justify-between gap-3 py-2"
                key={launch.record.id}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {launch.record.name}
                  </span>
                  {isIdea(launch.record) ? (
                    <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary-ink">
                      Idea
                    </span>
                  ) : (
                    <StageBadge stage={effectiveStage(launch)} />
                  )}
                </span>
                <Link
                  className="shrink-0 text-sm font-medium underline underline-offset-2"
                  params={{ launchId: launch.record.id }}
                  search={{ action: undefined, author: launch.record.author }}
                  to="/launchpad/$launchId"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
