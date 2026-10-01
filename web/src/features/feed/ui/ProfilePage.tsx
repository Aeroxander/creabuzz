import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Link as LinkIcon, VolumeX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { parseEntity } from "@/shared/lib/nip19";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { extractImages } from "../content";
import type { Post } from "../feed-model";
import {
  isFeedPreview,
  usePostsByIds,
  useProfiles,
  useTimeline,
  useViewerPubkey,
} from "../use-feed";
import {
  useContacts,
  useFollowers,
  useLikedIds,
  useMuted,
  useToggleFollow,
  useToggleMute,
} from "../use-social";
import { Avatar, displayNameOf, pubkeyToHue } from "./Avatar";
import { EditProfileDialog } from "./EditProfileDialog";
import { FeedShell } from "./FeedShell";
import { Message } from "./Message";
import { TabBar } from "./TabBar";
import { PostList, TimelineSkeleton } from "./Timeline";

type Tab = "posts" | "replies" | "media" | "likes";

const TABS: { id: Tab; label: string }[] = [
  { id: "posts", label: "Posts" },
  { id: "replies", label: "Replies" },
  { id: "media", label: "Media" },
  { id: "likes", label: "Likes" },
];

const SELECT: Record<Exclude<Tab, "likes">, (post: Post) => boolean> = {
  posts: (p) => p.parentId === null,
  replies: (p) => p.parentId !== null,
  media: (p) => extractImages(p.event.content).length > 0,
};

function Count({
  value,
  label,
  capped,
}: {
  value: number | undefined;
  label: string;
  capped?: boolean;
}) {
  return (
    <span className="text-[15px]">
      <b>{value === undefined ? "–" : `${value}${capped ? "+" : ""}`}</b>{" "}
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function FollowButton({ viewer, target }: { viewer: string; target: string }) {
  const following = useContacts(viewer).data?.includes(target) ?? false;
  const toggle = useToggleFollow(viewer);
  const [hover, setHover] = useState(false);
  return (
    <Button
      variant={following ? "outline" : "default"}
      className={cn(
        "rounded-full px-4 font-bold",
        following &&
          hover &&
          "border-destructive/50 bg-destructive/10 text-destructive",
        !following && "bg-foreground text-background hover:bg-foreground/90",
      )}
      aria-pressed={following}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() =>
        toggle.mutate(
          { value: target, add: !following },
          { onError: (e) => toast.error(e.message) },
        )
      }
    >
      {following ? (hover ? "Unfollow" : "Following") : "Follow"}
    </Button>
  );
}

function MuteButton({ viewer, target }: { viewer: string; target: string }) {
  const muted = useMuted(viewer).data?.includes(target) ?? false;
  const toggle = useToggleMute(viewer);
  return (
    <Button
      variant="outline"
      size="icon"
      className="rounded-full"
      aria-label={muted ? "Unmute" : "Mute"}
      aria-pressed={muted}
      title={muted ? "Unmute" : "Mute"}
      onClick={() =>
        toggle.mutate(
          { value: target, add: !muted },
          {
            onSuccess: () => toast.success(muted ? "Unmuted" : "Muted"),
            onError: (e) => toast.error(e.message),
          },
        )
      }
    >
      <VolumeX className={cn(muted && "text-destructive")} />
    </Button>
  );
}

function LikesTab({
  pubkey,
  viewer,
}: {
  pubkey: string;
  viewer: string | null;
}) {
  const ids = useLikedIds(pubkey);
  const posts = usePostsByIds(ids.data ?? []);
  if (ids.isLoading || posts.isLoading) return <TimelineSkeleton />;
  if (!posts.data?.length) {
    return (
      <Message
        title="No likes yet"
        body="Posts this account likes will show up here."
      />
    );
  }
  return <PostList posts={posts.data} viewer={viewer} />;
}

function AuthorTab({
  pubkey,
  tab,
  viewer,
}: {
  pubkey: string;
  tab: Exclude<Tab, "likes">;
  viewer: string | null;
}) {
  const timeline = useTimeline({
    key: ["author", pubkey, tab],
    authors: [pubkey],
    select: SELECT[tab],
  });
  const posts = timeline.data?.pages.flatMap((p) => p.posts) ?? [];
  if (timeline.isLoading) return <TimelineSkeleton />;
  if (timeline.isError)
    return (
      <Message title="Something went wrong" body={timeline.error.message} />
    );
  if (posts.length === 0) {
    return (
      <Message
        title="Nothing here yet"
        body="When this account posts, it will show up here."
      />
    );
  }
  return (
    <PostList
      posts={posts}
      viewer={viewer}
      hasMore={timeline.hasNextPage}
      isFetchingMore={timeline.isFetchingNextPage}
      onLoadMore={() => {
        if (!timeline.isFetchingNextPage) timeline.fetchNextPage();
      }}
    />
  );
}

export function ProfilePage() {
  const { id } = useParams({ from: "/p/$id" });
  const entity = parseEntity(id);
  const pubkey = entity?.type === "pubkey" ? entity.pubkey : null;
  const viewer = useViewerPubkey();
  const [tab, setTab] = useState<Tab>("posts");
  const [editing, setEditing] = useState(false);

  if (!pubkey) {
    return (
      <FeedShell>
        <Message
          title="This account doesn’t exist"
          body="Check the link and try again."
        />
      </FeedShell>
    );
  }

  return (
    <ProfileView
      pubkey={pubkey}
      viewer={viewer}
      tab={tab}
      onTab={setTab}
      editing={editing}
      setEditing={setEditing}
    />
  );
}

function ProfileView({
  pubkey,
  viewer,
  tab,
  onTab,
  editing,
  setEditing,
}: {
  pubkey: string;
  viewer: string | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
  editing: boolean;
  setEditing: (open: boolean) => void;
}) {
  const profile = useProfiles([pubkey]).data?.get(pubkey);
  const following = useContacts(pubkey);
  const followers = useFollowers(pubkey);
  const isSelf = viewer === pubkey;
  const name = displayNameOf(pubkey, profile);

  return (
    <FeedShell>
      <div className="sticky top-0 z-20 flex h-[53px] items-center gap-6 border-b bg-background/85 px-4 backdrop-blur">
        <Link
          to="/feed"
          aria-label="Back to feed"
          className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-foreground/10"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="truncate text-xl font-bold">{name}</h1>
      </div>

      <div
        className="h-32 bg-muted sm:h-48"
        style={
          profile?.banner
            ? undefined
            : {
                backgroundImage: `linear-gradient(135deg, hsl(${pubkeyToHue(pubkey)} 55% 45%), hsl(${(pubkeyToHue(pubkey) + 60) % 360} 55% 35%))`,
              }
        }
      >
        {profile?.banner && (
          <img
            src={profile.banner}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        )}
      </div>

      <div className="px-4 pb-3">
        <div className="flex items-start justify-between">
          <Avatar
            pubkey={pubkey}
            profile={profile}
            className="-mt-12 h-24 w-24 border-4 border-background text-3xl sm:-mt-16 sm:h-[134px] sm:w-[134px] sm:text-5xl"
          />
          <div className="flex items-center gap-2 pt-3">
            {isSelf ? (
              <Button
                variant="outline"
                className="rounded-full px-4 font-bold"
                disabled={isFeedPreview()}
                onClick={() => setEditing(true)}
              >
                Edit profile
              </Button>
            ) : viewer ? (
              <>
                <MuteButton viewer={viewer} target={pubkey} />
                <FollowButton viewer={viewer} target={pubkey} />
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-2 leading-6">
          <div className="text-xl font-extrabold">{name}</div>
          <div className="text-[15px] text-muted-foreground">
            {profile?.name ? `@${profile.name}` : truncatePubkey(pubkey)}
            {profile?.nip05 && <span> · {profile.nip05}</span>}
          </div>
        </div>
        {profile?.about && (
          <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-5">
            {profile.about}
          </p>
        )}
        {profile?.website && (
          <a
            href={profile.website}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="mt-2 inline-flex items-center gap-1 text-[15px] text-primary hover:underline"
          >
            <LinkIcon className="h-4 w-4" />
            {profile.website.replace(/^https?:\/\//, "")}
          </a>
        )}
        <div className="mt-3 flex gap-5">
          <Count value={following.data?.length} label="Following" />
          <Count
            value={followers.data?.count}
            capped={followers.data?.capped}
            label={followers.data?.count === 1 ? "Follower" : "Followers"}
          />
        </div>
      </div>

      <div className="sticky top-[53px] z-10 border-b bg-background/85 backdrop-blur">
        <TabBar tabs={TABS} value={tab} onChange={onTab} />
      </div>

      {tab === "likes" ? (
        <LikesTab pubkey={pubkey} viewer={viewer} />
      ) : (
        <AuthorTab pubkey={pubkey} tab={tab} viewer={viewer} />
      )}

      {isSelf && (
        <EditProfileDialog
          open={editing}
          onClose={() => setEditing(false)}
          viewer={pubkey}
          profile={profile}
        />
      )}
    </FeedShell>
  );
}
