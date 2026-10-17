/**
 * What is waiting on you in the DAOs you are part of, at the top of Home: a decision you can back, a claim to review, a
 * payout to take. Each line names the DAO and says what to do, and opens the place to do it. It shows nothing until
 * something is waiting, and nothing at all when you have no wallet or no DAO.
 */

import { Link } from "@tanstack/react-router";

import { useWaitingOnMe } from "../use-waiting-on-me";

export function WaitingOnYou() {
  const { waiting } = useWaitingOnMe();
  if (waiting.length === 0) return null;
  return (
    <section
      aria-labelledby="waiting-on-you-title"
      className="glass rounded-2xl border p-5"
      data-testid="home-waiting"
    >
      <h2 className="text-base font-bold" id="waiting-on-you-title">
        Waiting on you
      </h2>
      <ul className="mt-2 divide-y divide-border/60">
        {waiting.flatMap(({ launch, items }) =>
          items.map((item) => (
            <li
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
              data-testid="home-waiting-item"
              key={`${launch.record.id}:${item.key}`}
            >
              <span className="min-w-0 text-sm">
                <span className="font-semibold">{launch.record.name}</span>
                {": "}
                {item.text}
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
                }}
                to="/launchpad/$launchId"
              >
                {item.action}
              </Link>
            </li>
          )),
        )}
      </ul>
    </section>
  );
}
