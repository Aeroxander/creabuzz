import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { displayText } from "@creaton/core/social/feed/feed-events.ts";
import type { UseQueryResult } from "@tanstack/react-query";
import { Flag, Megaphone, PenLine } from "lucide-react";
import { useState } from "react";
import { nameOf, type ProfileMetadata } from "../../lib/profiles";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { LazyComposer } from "../posts/LazyComposer";
import type { Project } from "./project-record";
import { type ProjectActivity, projectUpdates } from "./use-project";

/** What the team said, newest first: updates, goals and posts about the project. */
export function UpdatesTab({
  project,
  activity,
  profiles,
  canPost,
}: {
  project: Project;
  activity: UseQueryResult<ProjectActivity>;
  profiles: Record<string, ProfileMetadata> | undefined;
  canPost: boolean;
}) {
  const [composing, setComposing] = useState(false);
  const post = canPost ? (
    <>
      <Button
        block
        data-testid="project-post"
        onClick={() => setComposing(true)}
        variant="secondary"
      >
        <PenLine aria-hidden="true" size={18} />
        Post an update
      </Button>
      <LazyComposer
        launch={{ pubkey: project.author, id: project.id }}
        onOpenChange={setComposing}
        open={composing}
        title={`Post about ${project.name}`}
      />
    </>
  ) : null;
  if (activity.isPending)
    return <Card className="h-24 animate-pulse" tone="plain" />;
  if (activity.isError)
    return (
      <EmptyState
        action={
          <Button onClick={() => void activity.refetch()} variant="secondary">
            Try again
          </Button>
        }
        title="Updates could not be read"
      >
        {readFailureWords(activity.error).text}
      </EmptyState>
    );
  const updates = projectUpdates(project, activity.data);
  return (
    <div className="flex flex-col gap-3" data-testid="project-updates">
      {post}
      {updates.length === 0 ? (
        <EmptyState icon={<Megaphone size={28} />} title="No updates yet">
          The team posts what it did here, week by week.
        </EmptyState>
      ) : (
        updates.map((update) => (
          <article
            className="plain flex flex-col gap-1.5 rounded-2xl p-4"
            data-testid="project-update"
            key={update.id}
          >
            <div className="flex items-center gap-2 text-xs text-muted">
              {update.kind === "goal" ? (
                <Flag aria-hidden="true" className="text-mint-ink" size={14} />
              ) : null}
              <span className="font-semibold text-ink">
                {nameOf(profiles, update.author)}
              </span>
              <span>{relativeTime(update.at)}</span>
            </div>
            {update.title ? (
              <h3 className="font-semibold">{update.title}</h3>
            ) : null}
            {update.body ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {displayText(update.body)}
              </p>
            ) : null}
          </article>
        ))
      )}
    </div>
  );
}
