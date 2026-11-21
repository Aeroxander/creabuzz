import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { BackHeader } from "../../app/BackHeader";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { PostList } from "../posts/PostList";
import { HIDES_UNKNOWN } from "../room/room-words";
import { useVisiblePosts } from "../safety/use-hidden";
import {
  TOPIC,
  TOPIC_BAD,
  TOPIC_BAD_TITLE,
  TOPIC_EMPTY,
  TOPIC_LIMIT,
  TOPIC_READ_FAILED,
  topicAllHidden,
  topicEmptyTitle,
  topicOldest,
  topicSomeHidden,
  topicTitle,
} from "./tag-words";
import { useTopic } from "./use-topic";

/** Every post under one topic (`#lamps`), newest first, without what the reader hides or the rooms keep to themselves. */
export function TopicPage({ tag }: { tag: string }) {
  const lower = tag.toLowerCase();
  const valid = TOPIC.test(lower);
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-4"
      data-testid="topic-page"
    >
      <BackHeader title={valid ? topicTitle(lower) : "Topic"} />
      {valid ? (
        <Topic tag={lower} />
      ) : (
        <EmptyState testId="topic-bad" title={TOPIC_BAD_TITLE}>
          {TOPIC_BAD}
        </EmptyState>
      )}
    </main>
  );
}

function Topic({ tag }: { tag: string }) {
  const topic = useTopic(tag);
  const visible = useVisiblePosts(topic.data);
  if (topic.isError)
    return (
      <EmptyState
        action={
          <Button onClick={() => void topic.refetch()} variant="secondary">
            Try again
          </Button>
        }
        testId="topic-failed"
        title={TOPIC_READ_FAILED}
      >
        {readFailureWords(topic.error).text}
      </EmptyState>
    );
  if (topic.isPending || !visible.ready)
    return (
      <Card
        className="h-24 animate-pulse"
        data-testid="topic-loading"
        tone="plain"
      />
    );
  const read = topic.data.length;
  if (visible.shown.length === 0)
    return read === 0 ? (
      <EmptyState testId="topic-empty" title={topicEmptyTitle(tag)}>
        {TOPIC_EMPTY}
      </EmptyState>
    ) : (
      <EmptyState testId="topic-all-hidden" title={topicEmptyTitle(tag)}>
        {topicAllHidden(visible.hidden)}
      </EmptyState>
    );
  return (
    <>
      {visible.unknown ? (
        <p
          className="px-1 text-sm text-muted"
          data-testid="topic-hides-unknown"
        >
          {HIDES_UNKNOWN}
        </p>
      ) : null}
      <PostList events={visible.shown} testId="topic-list" />
      {visible.hidden > 0 ? (
        <p className="px-1 text-sm text-muted" data-testid="topic-hidden">
          {topicSomeHidden(visible.hidden)}
        </p>
      ) : null}
      {read >= TOPIC_LIMIT ? (
        <p className="px-1 text-sm text-muted">{topicOldest(TOPIC_LIMIT)}</p>
      ) : null}
    </>
  );
}
