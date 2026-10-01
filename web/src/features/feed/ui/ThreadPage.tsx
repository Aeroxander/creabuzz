import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { relativeTime } from "@/shared/lib/relative-time";
import { NoteContent } from "../content";
import { useProfiles, useThread, useViewerPubkey } from "../use-feed";
import { Avatar, displayNameOf } from "./Avatar";
import { Composer } from "./Composer";
import { FeedShell } from "./FeedShell";
import { PostList, TimelineSkeleton } from "./Timeline";

export function ThreadPage() {
  const { noteId } = useParams({ from: "/feed/$noteId" });
  const viewer = useViewerPubkey();
  const thread = useThread(noteId);
  const root = thread.data?.root ?? null;
  const replies = thread.data?.replies ?? [];
  const profiles = useProfiles([
    ...(viewer ? [viewer] : []),
    ...(root ? [root.event.pubkey] : []),
  ]);
  const rootProfile = root ? profiles.data?.get(root.event.pubkey) : undefined;

  return (
    <FeedShell>
      <div className="sticky top-0 z-10 flex h-[53px] items-center gap-6 border-b bg-background/85 px-4 backdrop-blur">
        <Link
          to="/feed"
          aria-label="Back to feed"
          className="-ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-foreground/10"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-xl font-bold">Post</h1>
      </div>

      {thread.isLoading ? (
        <TimelineSkeleton />
      ) : !root ? (
        <div className="px-8 py-16 text-center text-[15px] text-muted-foreground">
          This post doesn’t exist or hasn’t reached this relay.
        </div>
      ) : (
        <>
          <article className="border-b px-4 pt-3">
            <div className="flex items-center gap-3">
              <Avatar pubkey={root.event.pubkey} profile={rootProfile} />
              <div className="min-w-0 leading-5">
                <div className="truncate font-bold">
                  {displayNameOf(root.event.pubkey, rootProfile)}
                </div>
                {rootProfile?.name && (
                  <div className="truncate text-muted-foreground">
                    @{rootProfile.name}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 text-[17px]">
              <NoteContent content={root.event.content} />
            </div>
            <div className="my-4 text-[15px] text-muted-foreground">
              {new Date(root.event.created_at * 1000).toLocaleString(
                undefined,
                {
                  hour: "numeric",
                  minute: "2-digit",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                },
              )}{" "}
              · {relativeTime(root.event.created_at)}
            </div>
            <div className="flex gap-5 border-t py-3 text-[15px]">
              <span>
                <b>{replies.length}</b>{" "}
                <span className="text-muted-foreground">
                  {replies.length === 1 ? "Reply" : "Replies"}
                </span>
              </span>
            </div>
          </article>
          <Composer
            viewer={viewer}
            profile={viewer ? profiles.data?.get(viewer) : undefined}
            replyTo={{ id: root.event.id, author: root.event.pubkey }}
            placeholder="Post your reply"
          />
          <PostList posts={replies} viewer={viewer} />
        </>
      )}
    </FeedShell>
  );
}
