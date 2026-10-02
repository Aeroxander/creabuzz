import { useParams } from "@tanstack/react-router";

import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError } from "@/shared/ui/query-error";

import { useThread } from "../use-social-data";
import { BackLink } from "./HashtagPage";
import { PostComposer } from "./PostComposer";
import { PostList } from "./PostList";
import { PageBar, SocialShell } from "./SocialShell";
import { EmptyState, TimelineSkeleton } from "./Status";

/** One post with the conversation above it and the replies below it. */
export function ThreadPage() {
  const { id } = useParams({ from: "/social/post/$id" });
  const thread = useThread(id);
  const note = thread.data?.note ?? null;
  const ancestors = thread.data?.ancestors ?? [];
  // Replies carry the thread's first post as their root.
  const root = ancestors[0]?.event ?? note?.event ?? null;

  return (
    <SocialShell>
      <PageBar
        back={<BackLink label="Back to the feed" to="/social" />}
        title="Post"
      />
      {thread.isError ? (
        <div className="p-4">
          <QueryError
            description="The server did not answer, so this post can't be shown."
            error={thread.error}
            kinds={[KIND_TEXT_NOTE]}
            onRetry={() => void thread.refetch()}
            relayUrl={relayWsUrl()}
            testId="social-thread-error"
            title="Couldn't load this post"
          />
        </div>
      ) : thread.isLoading ? (
        <TimelineSkeleton />
      ) : !note || !root ? (
        <EmptyState title="This post isn't available">
          It may have been deleted, or this relay hasn't received it.
        </EmptyState>
      ) : (
        <>
          {ancestors.length > 0 ? <PostList rows={ancestors} /> : null}
          <div data-testid="social-thread-focus">
            <PostList rows={[note]} />
          </div>
          <PostComposer
            placeholder="Post your reply"
            replyTo={{ root, parent: note.event }}
            testId="social-reply-composer"
          />
          <PostList rows={thread.data?.replies ?? []} />
        </>
      )}
    </SocialShell>
  );
}
