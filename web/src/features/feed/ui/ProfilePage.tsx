import { Link } from "@tanstack/react-router";
import { ArrowLeft, Link as LinkIcon, Mail, VolumeX } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useLaunches } from "@/features/launchpad/use-launches";
import {
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import { tokenize } from "@/features/social/lib/content";
import { EditProfileDialog } from "@/features/social/ui/EditProfileDialog";
import { PostList } from "@/features/social/ui/PostList";
import { PageBar, SocialShell } from "@/features/social/ui/SocialShell";
import { EmptyState, TimelineSkeleton } from "@/features/social/ui/Status";
import { TabStrip } from "@/features/social/ui/TabStrip";
import { usePeople } from "@/features/social/use-people";
import {
  useMutedPeople,
  useToggleMute,
} from "@/features/social/use-social-actions";
import {
  useFollowerCount,
  useFollowing,
  useLikedIds,
  useNotesById,
  useTimeline,
} from "@/features/social/use-social-data";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { EMPTY_TALLY } from "../lib/ranking";
import { useVoteTallies, useVoteWeights } from "../use-feed";
import { FollowButton } from "./FollowButton";
import { launchCoord, LaunchVoteCard } from "./LaunchVoteCard";
import { formatScore } from "./VoteButtons";

type Tab = "posts" | "replies" | "media" | "likes" | "launches";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "posts", label: "Posts" },
  { id: "replies", label: "Replies" },
  { id: "media", label: "Media" },
  { id: "likes", label: "Likes" },
  { id: "launches", label: "Launches" },
];

/** A stable banner colour for people who have not set a header image. */
function bannerHue(pubkey: string): number {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function Count({
  value,
  label,
  testId,
}: {
  value: string;
  label: string;
  testId: string;
}) {
  return (
    <span className="text-sm" data-testid={testId}>
      <b className="text-black dark:text-white">{value}</b>{" "}
      <span className="text-black/60 dark:text-white/60">{label}</span>
    </span>
  );
}

function AuthorPosts({
  pubkey,
  tab,
}: {
  pubkey: string;
  tab: "posts" | "replies" | "media";
}) {
  const timeline = useTimeline({
    key: ["author", pubkey, tab],
    authors: [pubkey],
    reposts: tab === "posts",
    select:
      tab === "posts"
        ? (row) => row.replyToId === null
        : tab === "replies"
          ? (row) => row.replyToId !== null
          : (row) =>
              tokenize(row.event.content).some((t) => t.type === "image"),
  });
  const rows = timeline.data?.pages.flatMap((p) => p.rows) ?? [];
  if (timeline.isLoading) return <TimelineSkeleton />;
  if (rows.length === 0) {
    return (
      <EmptyState testId="profile-posts-list" title="Nothing here yet">
        When this account posts, it shows up here.
      </EmptyState>
    );
  }
  return (
    <div data-testid="profile-posts-list">
      <PostList
        hasMore={timeline.hasNextPage}
        loadingMore={timeline.isFetchingNextPage}
        onLoadMore={() => {
          if (!timeline.isFetchingNextPage) void timeline.fetchNextPage();
        }}
        rows={rows}
      />
    </div>
  );
}

function Likes({ pubkey }: { pubkey: string }) {
  const ids = useLikedIds(pubkey);
  const notes = useNotesById(ids.data ?? []);
  if (ids.isLoading || (ids.data?.length && notes.isLoading)) {
    return <TimelineSkeleton />;
  }
  if (!notes.data?.length) {
    return (
      <EmptyState title="No likes yet">
        Posts this account likes show up here.
      </EmptyState>
    );
  }
  return <PostList rows={notes.data} />;
}

function Launches({ pubkey }: { pubkey: string }) {
  const launches = useLaunches();
  const weights = useVoteWeights();
  const { tallies } = useVoteTallies();
  const founded = useMemo(
    () => (launches.data ?? []).filter((l) => l.record.author === pubkey),
    [launches.data, pubkey],
  );
  const weight = weights.data?.(pubkey);
  return (
    <div className="p-4">
      {weight !== undefined ? (
        <p
          className="text-xs text-black/60 dark:text-white/60"
          data-testid="profile-vote-weight"
        >
          Their vote counts {formatScore(weight)}×. Votes count more once
          someone with a role in the organisation has accepted a person's work.
        </p>
      ) : null}
      {founded.length === 0 ? (
        <p className="mt-3 text-sm text-black/60 dark:text-white/60">
          No launches started yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {founded.map((launch) => (
            <li key={launch.record.id}>
              <LaunchVoteCard
                record={launch.record}
                tally={tallies.get(launchCoord(launch.record)) ?? EMPTY_TALLY}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One person: header image, avatar, bio, follow counts, and tabs for their
 * posts, replies, media, likes and the launches they started.
 */
export function ProfilePage({ pubkey }: { pubkey: string }) {
  const me = existingUserPubkey();
  const [tab, setTab] = useState<Tab>("posts");
  const [editing, setEditing] = useState(false);
  const people = usePeople([pubkey]);
  const profile = people[pubkey];
  const name = resolveUserName(profile, pubkey);
  const following = useFollowing(pubkey);
  const followers = useFollowerCount(pubkey);
  const muted = useMutedPeople().data?.has(pubkey) ?? false;
  const toggleMute = useToggleMute();
  const isSelf = me === pubkey;
  const hue = bannerHue(pubkey);

  return (
    <SocialShell>
      <PageBar
        back={
          <Link
            aria-label="Back to the feed"
            className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            to="/social"
          >
            <ArrowLeft aria-hidden className="h-5 w-5" />
          </Link>
        }
        title={name}
      />
      <div
        className="h-28 bg-black/10 sm:h-40 dark:bg-white/10"
        style={
          profile?.banner
            ? undefined
            : {
                backgroundImage: `linear-gradient(135deg, hsl(${hue} 55% 45%), hsl(${(hue + 60) % 360} 55% 35%))`,
              }
        }
      >
        {profile?.banner ? (
          <img
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            src={profile.banner}
          />
        ) : null}
      </div>

      <div className="px-4 pb-3">
        <div className="flex items-start justify-between">
          <UserAvatar
            avatarUrl={profile?.picture ?? null}
            className="-mt-10 h-20 w-20 border-4 border-white text-xl sm:-mt-14 sm:h-28 sm:w-28 sm:text-3xl dark:border-black"
            displayName={name}
          />
          <div className="flex items-center gap-2 pt-3">
            {isSelf ? (
              <Button
                className="rounded-full px-4 font-semibold"
                data-testid="profile-edit"
                onClick={() => setEditing(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                Edit profile
              </Button>
            ) : me ? (
              <>
                <Button
                  aria-label={muted ? "Unmute" : "Mute"}
                  aria-pressed={muted}
                  className="rounded-full"
                  data-testid="profile-mute"
                  disabled={toggleMute.isPending}
                  onClick={() =>
                    toggleMute.mutate(
                      { pubkey, muted: !muted },
                      {
                        onSuccess: () =>
                          toast.success(muted ? "Unmuted" : "Muted"),
                        onError: (error) =>
                          toast.error(
                            error instanceof Error
                              ? error.message
                              : "That didn't work.",
                          ),
                      },
                    )
                  }
                  size="icon"
                  title={muted ? "Unmute" : "Mute"}
                  type="button"
                  variant="outline"
                >
                  <VolumeX
                    aria-hidden
                    className={muted ? "text-red-600" : undefined}
                  />
                </Button>
                <Button
                  asChild
                  className="rounded-full"
                  size="icon"
                  variant="outline"
                >
                  <Link
                    aria-label="Message"
                    data-testid="profile-message"
                    params={{ peer: pubkey }}
                    title="Message"
                    to="/social/messages/$peer"
                  >
                    <Mail aria-hidden />
                  </Link>
                </Button>
                <FollowButton
                  label={name}
                  person={pubkey}
                  testId="profile-follow"
                />
              </>
            ) : null}
          </div>
        </div>

        <h2 className="mt-2 text-xl font-extrabold text-black dark:text-white">
          {name}
        </h2>
        <p className="text-sm text-black/60 dark:text-white/60">
          {resolveUserSecondaryName(profile, pubkey)}
        </p>
        {profile?.about ? (
          <p className="mt-3 whitespace-pre-wrap break-words text-sm text-black dark:text-white">
            {profile.about}
          </p>
        ) : null}
        {profile?.website ? (
          <a
            className="mt-2 inline-flex items-center gap-1 text-sm text-sky-700 hover:underline dark:text-sky-400"
            href={profile.website}
            rel="noopener noreferrer nofollow"
            target="_blank"
          >
            <LinkIcon aria-hidden className="h-4 w-4" />
            {profile.website.replace(/^https?:\/\//, "")}
          </a>
        ) : null}
        <div className="mt-3 flex gap-5">
          <Count
            label="Following"
            testId="profile-following-count"
            value={following.data ? String(following.data.length) : "–"}
          />
          <Count
            label={followers.data?.count === 1 ? "Follower" : "Followers"}
            testId="profile-followers-count"
            value={
              followers.data
                ? `${followers.data.count}${followers.data.capped ? "+" : ""}`
                : "–"
            }
          />
        </div>
      </div>

      <div className="sticky top-12 z-10 border-b border-black/10 bg-white/90 backdrop-blur max-md:top-[5.75rem] dark:border-white/10 dark:bg-black/80">
        <TabStrip label="Profile" onChange={setTab} tabs={TABS} value={tab} />
      </div>

      {tab === "posts" || tab === "replies" || tab === "media" ? (
        <AuthorPosts pubkey={pubkey} tab={tab} />
      ) : tab === "likes" ? (
        <Likes pubkey={pubkey} />
      ) : (
        <Launches pubkey={pubkey} />
      )}

      {isSelf ? (
        <EditProfileDialog
          onClose={() => setEditing(false)}
          open={editing}
          profile={profile}
        />
      ) : null}
    </SocialShell>
  );
}
