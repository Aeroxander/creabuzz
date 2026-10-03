/**
 * What happened on your launches while you were away: new supporters, and
 * backers waiting to be let into the backers room. Shown at the top of
 * notifications, and only when there is something to act on.
 */

import { Link } from "@tanstack/react-router";
import { Rocket } from "lucide-react";

import { truncatePubkey } from "@/shared/lib/pubkey";

import { useFounderActivity } from "../use-founder-activity";
import { useAdmitBackers } from "../use-launch-chat";
import type { Launch } from "../models";

function LaunchLink({
  id,
  author,
  children,
}: {
  id: string;
  author: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      className="font-semibold underline"
      params={{ launchId: id }}
      search={{ action: undefined, author }}
      to="/launchpad/$launchId"
    >
      {children}
    </Link>
  );
}

function WaitingBackers({ launch }: { launch: Launch }) {
  const { waiting } = useAdmitBackers(launch);
  if (!launch.record.chat.backers || waiting.length === 0) return null;
  return (
    <li data-testid="your-launches-waiting">
      {waiting.length === 1
        ? `${truncatePubkey(waiting[0])} is waiting to join the backers room of `
        : `${waiting.length} backers are waiting to join the backers room of `}
      <LaunchLink author={launch.record.author} id={launch.record.id}>
        {launch.record.name}
      </LaunchLink>
    </li>
  );
}

export function YourLaunchesSection() {
  const { rows, mine } = useFounderActivity();
  const withBackers = mine.filter((launch) => launch.record.chat.backers);
  if (rows.length === 0 && withBackers.length === 0) return null;
  return (
    <section
      aria-label="Your launches"
      className="border-b border-primary/30 bg-primary/[0.04] px-4 py-3"
      data-testid="your-launches"
    >
      <h2 className="flex items-center gap-2 text-sm font-bold text-primary-ink">
        <Rocket aria-hidden className="h-4 w-4" /> Your launches
      </h2>
      <ul className="mt-1.5 space-y-1 text-sm">
        {rows.map((row) => (
          <li data-testid="your-launches-supporters" key={row.coord}>
            {row.fresh === 1
              ? "1 new supporter on "
              : `${row.fresh} new supporters on `}
            <LaunchLink author={row.author} id={row.id}>
              {row.name}
            </LaunchLink>
          </li>
        ))}
        {withBackers.map((launch) => (
          <WaitingBackers
            key={`${launch.record.author}:${launch.record.id}`}
            launch={launch}
          />
        ))}
      </ul>
    </section>
  );
}
