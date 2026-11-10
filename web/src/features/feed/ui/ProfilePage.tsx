import { Link } from "@tanstack/react-router";
import { ArrowLeft, Link as LinkIcon, Mail } from "lucide-react";
import { useMemo, useState } from "react";

import {
  SIGN_IN_EVENT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { useLaunches } from "@/features/launchpad/use-launches";
import { PaymentWalletCard } from "@/features/identity/ui/PaymentWalletCard";
import { AccountMoneyCard } from "@/features/launchpad/ui/AccountMoneyCard";
import {
  hasUserName,
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import { tokenize } from "@/features/social/lib/content";
import {
  firstError,
  firstPageError,
  listView,
  olderPageError,
  partialError,
} from "@/features/social/lib/read-view";
import { EditProfileDialog } from "@/features/social/ui/EditProfileDialog";
import { PostList } from "@/features/social/ui/PostList";
import {
  SCORE_POSTS,
  useAuthorScore,
} from "@/features/social/use-author-score";
import { useMixedTimeline } from "@/features/social/use-mixed-timeline";
import {
  MutePersonButton,
  ReportPersonButton,
} from "@/features/social/ui/PersonSafety";
import { PageBar, SocialShell } from "@/features/social/ui/SocialShell";
import {
  EmptyState,
  PartialFailure,
  TimelineSkeleton,
} from "@/features/social/ui/Status";
import { TabStrip, tabPanelProps } from "@/features/social/ui/TabStrip";
import { usePeople } from "@/features/social/use-people";
import {
  useFollowerCount,
  useFollowing,
  useLikedIds,
  useNotesById,
  useTimeline,
} from "@/features/social/use-social-data";
import { KIND_REACTION, KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { ServerImage } from "@/shared/ui/ServerImage";

import { EMPTY_TALLY } from "../lib/ranking";
import { trustTierLabel } from "../lib/trust-weight";
import { useVoteTallies, useVoteWeights } from "../use-feed";
import { FollowButton } from "./FollowButton";
import { launchCoord, LaunchVoteCard } from "./LaunchVoteCard";
import { ForecastRecordLine } from "@/features/launchpad/ui/ForecastRecordLine";

type Tab = "posts" | "replies" | "media" | "likes" | "launches";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "posts", label: "Posts" },
  { id: "replies", label: "Replies" },
  { id: "media", label: "Media" },
  { id: "likes", label: "Upvoted" },
  { id: "launches", label: "Projects" },
];

/** A stable banner colour for people who have not set a header image. */
function bannerHue(pubkey: string): number {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** One figure on a profile; a pulsing bar while it is read, so a count never shows as a dash first. */
function Count({
  value,
  label,
  testId,
  labelFirst = false,
}: {
  value: string | undefined;
  label: string;
  testId: string;
  /** "Score 7" rather than "7 Following". */
  labelFirst?: boolean;
}) {
  const figure =
    value === undefined ? (
      <span
        aria-label="Loading"
        className="inline-block h-3.5 w-5 animate-pulse rounded bg-black/10 align-middle dark:bg-white/15"
        data-testid={`${testId}-loading`}
        role="img"
      />
    ) : (
      <b className="text-black dark:text-white">{value}</b>
    );
  const words = (
    <span className="text-black/60 dark:text-white/60">{label}</span>
  );
  return (
    <span className="text-sm" data-testid={testId}>
      {labelFirst ? words : figure} {labelFirst ? figure : words}
    </span>
  );
}

/** Posts: their short posts and board posts together, newest first. Replies and Media: short posts only. */
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
    enabled: tab !== "posts",
    select:
      tab === "replies"
        ? (row) => row.replyToId !== null
        : (row) => tokenize(row.event.content).some((t) => t.type === "image"),
  });
  const mixed = useMixedTimeline({
    tab: "following",
    authors: [pubkey],
    enabled: tab === "posts",
  });
  const rows = timeline.data?.pages.flatMap((p) => p.rows) ?? [];
  const error = tab === "posts" ? mixed.error : firstPageError(timeline);
  const view = listView({
    count: tab === "posts" ? mixed.items.length : rows.length,
    error,
    loading: tab === "posts" ? mixed.isLoading : timeline.isLoading,
  });
  const retry = () =>
    tab === "posts" ? mixed.refetch() : void timeline.refetch();
  if (view === "loading") return <TimelineSkeleton />;
  if (view === "error") {
    return (
      <div className="p-4">
        <QueryError
          description="The server did not answer, so this account's posts can't be shown. They are not known to be empty."
          error={error}
          kinds={[KIND_TEXT_NOTE]}
          onRetry={retry}
          relayUrl={relayWsUrl()}
          testId="profile-posts-error"
          title="Couldn't load posts"
        />
      </div>
    );
  }
  if (view === "empty") {
    return (
      <EmptyState testId="profile-posts-list" title="Nothing here yet">
        When this account posts, it shows up here.
      </EmptyState>
    );
  }
  return (
    <div data-testid="profile-posts-list">
      {partialError(view, error) ? (
        <PartialFailure onRetry={retry} testId="profile-posts-partial-error">
          Some of this account's posts couldn't be loaded, so this list may not
          be complete.
        </PartialFailure>
      ) : null}
      {tab === "posts" ? (
        <PostList
          boards={mixed.boards}
          hasMore={mixed.hasMore}
          items={mixed.items}
          loadMoreError={mixed.loadMoreError}
          loadingMore={mixed.loadingMore}
          onLoadMore={mixed.loadMore}
        />
      ) : (
        <PostList
          hasMore={timeline.hasNextPage}
          loadMoreError={olderPageError(timeline)}
          loadingMore={timeline.isFetchingNextPage}
          onLoadMore={() => {
            if (!timeline.isFetchingNextPage) void timeline.fetchNextPage();
          }}
          rows={rows}
        />
      )}
    </div>
  );
}

function Likes({ pubkey }: { pubkey: string }) {
  const ids = useLikedIds(pubkey);
  const notes = useNotesById(ids.data ?? []);
  const error = firstError(ids.error, notes.error);
  const view = listView({
    count: notes.data?.length ?? 0,
    error,
    loading: ids.isLoading || Boolean(ids.data?.length && notes.isLoading),
  });
  const retry = () => {
    void ids.refetch();
    if (notes.error) void notes.refetch();
  };
  if (view === "loading") return <TimelineSkeleton />;
  if (view === "error") {
    return (
      <div className="p-4">
        <QueryError
          description="The server did not answer, so the posts this account voted up can't be shown."
          error={error}
          kinds={[KIND_REACTION, KIND_TEXT_NOTE]}
          onRetry={retry}
          relayUrl={relayWsUrl()}
          testId="profile-likes-error"
          title="Couldn't load upvoted posts"
        />
      </div>
    );
  }
  if (view === "empty") {
    return (
      <EmptyState title="No upvotes yet">
        Posts this account voted up show up here.
      </EmptyState>
    );
  }
  return (
    <>
      {partialError(view, error) ? (
        <PartialFailure onRetry={retry} testId="profile-likes-partial-error">
          Some upvoted posts couldn't be loaded, so this list may not be
          complete.
        </PartialFailure>
      ) : null}
      <PostList rows={notes.data} />
    </>
  );
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
          Trust: {trustTierLabel(weight)}. Votes count more once someone with a
          role in the organisation has accepted a person's work.
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
 * A `/u/` address that names nobody (`app/lib/profile-param.ts`), or `/u/me` with no account here: said plainly,
 * with the way on, instead of a made-up person.
 */
export function ProfileMissing({ signedOut }: { signedOut: boolean }) {
  return (
    <SocialShell>
      <PageBar
        back={
          <Link
            aria-label="Back to Home"
            className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            to="/"
          >
            <ArrowLeft aria-hidden className="h-5 w-5" />
          </Link>
        }
        title="Profile"
      />
      {signedOut ? (
        <EmptyState testId="profile-signed-out" title="You're not signed in">
          Sign in to see your profile, or make an account.
        </EmptyState>
      ) : (
        <EmptyState
          testId="profile-not-found"
          title="This profile can't be found"
        >
          Check the link, or search for them by name.
        </EmptyState>
      )}
      <div className="flex justify-center gap-2 pb-10">
        {signedOut ? (
          <>
            <Button
              onClick={() => window.dispatchEvent(new Event(SIGN_IN_EVENT))}
              variant="outline"
            >
              Sign in
            </Button>
            <Button
              onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
            >
              Sign up
            </Button>
          </>
        ) : (
          <Button asChild variant="outline">
            <Link to="/">Home</Link>
          </Button>
        )}
      </div>
    </SocialShell>
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
  const isSelf = me === pubkey;
  // Your own profile before you have picked a name is "Your account", as the account menu calls it, never a key.
  const nameless = isSelf && !hasUserName(profile);
  const name = nameless ? "Your account" : resolveUserName(profile, pubkey);
  const following = useFollowing(pubkey);
  const followers = useFollowerCount(pubkey);
  const score = useAuthorScore(pubkey);
  // What points are, shown on a tap as well as on hover: a phone has no hover.
  const [pointsHelp, setPointsHelp] = useState(false);
  const hue = bannerHue(pubkey);

  return (
    <SocialShell>
      <PageBar
        back={
          <Link
            aria-label="Back to Home"
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
          <ServerImage
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            src={profile.banner}
            unavailable="hide"
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
                variant={nameless ? "default" : "outline"}
              >
                {nameless ? "Add your name" : "Edit profile"}
              </Button>
            ) : me ? (
              <>
                <MutePersonButton pubkey={pubkey} testId="profile-mute" />
                <ReportPersonButton
                  name={name}
                  pubkey={pubkey}
                  testId="profile-report"
                />
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
        {nameless ? null : (
          <p className="text-sm text-black/60 dark:text-white/60">
            {resolveUserSecondaryName(profile, pubkey)}
          </p>
        )}
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
        <PaymentWalletCard isSelf={isSelf} key={pubkey} pubkey={pubkey} />
        {isSelf ? <AccountMoneyCard /> : null}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          <button
            aria-controls="profile-points-help"
            aria-expanded={pointsHelp}
            className="text-left"
            onClick={() => setPointsHelp((open) => !open)}
            title={`Up votes minus down votes on their newest ${SCORE_POSTS} posts and ${SCORE_POSTS} board posts: feedback on posts, not votes in any project and not Shares`}
            type="button"
          >
            <Count
              label="Score"
              labelFirst
              testId="profile-score"
              value={score.data === undefined ? undefined : String(score.data)}
            />
          </button>
          <Count
            label="Following"
            testId="profile-following-count"
            value={following.data ? String(following.data.length) : undefined}
          />
          <Count
            label={followers.data?.count === 1 ? "Follower" : "Followers"}
            testId="profile-followers-count"
            value={
              followers.data
                ? `${followers.data.count}${followers.data.capped ? "+" : ""}`
                : undefined
            }
          />
        </div>
        {pointsHelp ? (
          <p
            className="mt-1 text-xs text-black/60 dark:text-white/60"
            data-testid="profile-points-help"
            id="profile-points-help"
          >
            The score is up votes minus down votes on their newest {SCORE_POSTS}{" "}
            posts and {SCORE_POSTS} board posts: feedback on posts, not votes in
            any project and not Shares.
          </p>
        ) : null}
        <ForecastRecordLine pubkey={pubkey} />
      </div>

      <div className="sticky top-12 z-10 border-b border-border/60 bg-background/45 backdrop-blur-xl max-md:top-[5.75rem]">
        <TabStrip
          idBase="profile-tabs"
          label="Profile"
          onChange={setTab}
          tabs={TABS}
          value={tab}
        />
      </div>

      <div {...tabPanelProps("profile-tabs", tab)}>
        {tab === "posts" || tab === "replies" || tab === "media" ? (
          <AuthorPosts pubkey={pubkey} tab={tab} />
        ) : tab === "likes" ? (
          <Likes pubkey={pubkey} />
        ) : (
          <Launches pubkey={pubkey} />
        )}
      </div>

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
