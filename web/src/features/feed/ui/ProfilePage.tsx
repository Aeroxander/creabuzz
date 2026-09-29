import { useMemo } from "react";

import { useLaunches } from "@/features/launchpad/use-launches";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { EMPTY_TALLY } from "../lib/ranking";
import { useAuthorNotes, useVoteTallies, useVoteWeights } from "../use-feed";
import { FollowButton } from "./FollowButton";
import { formatScore } from "./VoteButtons";
import { launchCoord, LaunchVoteCard } from "./LaunchVoteCard";
import { ThreadList } from "./ThreadList";

/**
 * One person: who they are, how much their vote counts and why, the launches
 * they started, and what they have posted.
 */
export function ProfilePage({ pubkey }: { pubkey: string }) {
  const { data: profiles } = useProfiles([pubkey]);
  const profile = profiles?.[pubkey];
  const name = resolveUserName(profile, pubkey);
  const notes = useAuthorNotes(pubkey);
  const launches = useLaunches();
  const weights = useVoteWeights();
  const { tallies } = useVoteTallies();

  const founded = useMemo(
    () => (launches.data ?? []).filter((l) => l.record.author === pubkey),
    [launches.data, pubkey],
  );
  const weight = weights.data?.(pubkey);

  return (
    <div className="flex h-full w-full flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <UserAvatar
            avatarUrl={profile?.picture ?? null}
            displayName={name}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold text-black dark:text-white">
              {name}
            </h1>
            <p
              className="truncate font-mono text-xs text-black/60 dark:text-white/60"
              title={pubkey}
            >
              {truncatePubkey(pubkey)}
            </p>
          </div>
          <FollowButton label={name} person={pubkey} testId="profile-follow" />
        </header>
        {profile?.about ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-black/80 dark:text-white/80">
            {profile.about}
          </p>
        ) : null}
        {weight !== undefined ? (
          <p
            className="mt-3 text-xs text-black/60 dark:text-white/60"
            data-testid="profile-vote-weight"
          >
            Their vote counts {formatScore(weight)}×. Votes count more once
            someone with a role in the organisation has accepted a person's
            work.
          </p>
        ) : null}

        {founded.length > 0 ? (
          <section aria-labelledby="profile-launches" className="mt-6">
            <h2
              className="text-sm font-semibold text-black dark:text-white"
              id="profile-launches"
            >
              Launches started
            </h2>
            <ul className="mt-2 flex flex-col gap-2">
              {founded.map((launch) => (
                <li key={launch.record.id}>
                  <LaunchVoteCard
                    record={launch.record}
                    tally={
                      tallies.get(launchCoord(launch.record)) ?? EMPTY_TALLY
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="profile-posts" className="mt-6">
          <h2
            className="text-sm font-semibold text-black dark:text-white"
            id="profile-posts"
          >
            Posts
          </h2>
          <div className="mt-2">
            {notes.isLoading ? (
              <p
                className="text-sm text-black/60 dark:text-white/60"
                role="status"
              >
                Loading posts…
              </p>
            ) : (
              <ThreadList
                empty={
                  <p className="text-sm text-black/60 dark:text-white/60">
                    Nothing posted yet.
                  </p>
                }
                mode="new"
                notes={(notes.data ?? []).filter((n) => !n.rootId)}
                testId="profile-posts-list"
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
