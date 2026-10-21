/**
 * What is waiting on you in the DAOs you are part of, at the top of Home: a decision you can back, a claim to review, a
 * payout to take, a milestone to look at before its window closes. Most urgent first: what closes soonest comes before what
 * can wait. Each line names the project, says what to do, why it is shown to you, when it closes and what happens if nothing
 * is done, and opens the place to do it. It shows nothing until something is waiting, and nothing at all when you have no
 * wallet or no DAO. A project that could not be read is said so (with a way to ask again), never left out as if nothing
 * were waiting there.
 */

import { Link } from "@tanstack/react-router";

import { deadline } from "@/features/launchpad/lib/challenge-copy";
import { Button } from "@/shared/ui/button";

import { useWaitingOnMe } from "../use-waiting-on-me";

const names = (list: readonly string[]) =>
  list.length <= 2
    ? list.join(" and ")
    : `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;

export function WaitingOnYou() {
  const { queue, incomplete, retry } = useWaitingOnMe();
  if (queue.length === 0 && incomplete.length === 0) return null;
  return (
    <section
      aria-labelledby="waiting-on-you-title"
      className="glass rounded-2xl border p-5"
      data-testid="home-waiting"
    >
      <h2 className="text-base font-bold" id="waiting-on-you-title">
        Waiting on you
      </h2>
      {incomplete.length > 0 ? (
        <div
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="home-waiting-unread"
          role="status"
        >
          <span>
            {queue.length === 0
              ? `Could not read ${names(incomplete.map((l) => l.record.name))} just now, so we cannot say whether anything is waiting there.`
              : `Could not read ${names(incomplete.map((l) => l.record.name))} just now, so this list may be missing something.`}
          </span>
          <Button
            data-testid="home-waiting-retry"
            onClick={retry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : null}
      <ul className="mt-2 divide-y divide-border/60">
        {queue.map(({ launch, item, now }) => {
          const timed = item.due !== undefined && item.due > now;
          return (
            <li
              className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2"
              data-testid="home-waiting-item"
              key={`${launch.record.id}:${item.key}`}
            >
              <span className="min-w-0 text-sm">
                <span className="font-semibold">{launch.record.name}</span>
                {": "}
                {item.text}
                {item.why || item.ifIgnored || timed ? (
                  <span
                    className="mt-0.5 block text-xs text-muted-foreground"
                    data-testid="home-waiting-why"
                  >
                    {timed && item.due !== undefined
                      ? `Closes ${deadline(item.due)}. `
                      : ""}
                    {item.why ? `${item.why} ` : ""}
                    {item.ifIgnored ?? ""}
                  </span>
                ) : null}
              </span>
              <Link
                className="shrink-0 text-sm font-medium underline underline-offset-2"
                data-testid="home-waiting-open"
                params={{ launchId: launch.record.id }}
                search={{
                  action: undefined,
                  author: launch.record.author,
                  // The tab where the thing is acted on: a reviewer's bond or review is on Work, a vote on Decisions.
                  tab: item.tab,
                  // And the claim itself, when it is about one: the Work tab opens on it.
                  ...(item.claim
                    ? { claim: item.claim.id, mandate: item.claim.mandate }
                    : {}),
                }}
                to="/launchpad/$launchId"
              >
                {item.action}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
