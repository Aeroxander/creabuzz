import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { Link } from "@tanstack/react-router";
import { CalendarCheck, PenLine } from "lucide-react";
import { useState } from "react";
import { ScreenHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { ComposerSheet } from "../posts/Composer";
import { useProjectsBy } from "../profile/use-own-projects";
import { type Project, projectRef } from "../project/project-record";

/**
 * This week: the founder's ten minutes. In this part it lists the person's projects with a way to post about each;
 * the weekly update with its check-in (2 presses, 1 field) comes in the next part of milestone 6.
 */
export function WeekPage() {
  const { pubkey } = useAccount();
  const projects = useProjectsBy(pubkey);
  const [posting, setPosting] = useState<Project | null>(null);
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="week-page"
    >
      <ScreenHeader title="This week" />
      <p className="-mt-2 text-muted">
        Ten minutes a week: say what you did, and check in.
      </p>
      {!pubkey || (projects.data && projects.data.length === 0) ? (
        <EmptyState
          action={<ButtonLink to="/start">Start a project</ButtonLink>}
          icon={<CalendarCheck size={28} />}
          title="Nothing to do yet"
        >
          Start a project and your week shows here.
        </EmptyState>
      ) : projects.isPending ? (
        <Card className="h-28 animate-pulse" />
      ) : (
        (projects.data ?? []).map((project) => (
          <Card
            className="flex flex-col gap-3"
            data-testid="week-project"
            key={project.coordinate}
          >
            <div className="flex items-baseline justify-between gap-3">
              <Link
                className="headline text-xl hover:underline"
                params={{ ref: projectRef(project) }}
                to="/p/$ref"
              >
                {project.name}
              </Link>
              <span className="text-xs text-muted">
                started {relativeTime(project.startedAt)}
              </span>
            </div>
            <ul className="flex flex-col gap-2 text-sm">
              <li className="flex gap-2">
                <span aria-hidden="true" className="text-muted">
                  ○
                </span>
                <span>Post what you did this week</span>
              </li>
              <li className="flex gap-2">
                <span aria-hidden="true" className="text-muted">
                  ○
                </span>
                <span>
                  Check in <span className="text-muted">(coming soon)</span>
                </span>
              </li>
            </ul>
            <Button
              onClick={() => setPosting(project)}
              size="sm"
              variant="secondary"
            >
              <PenLine aria-hidden="true" size={16} />
              Post an update
            </Button>
          </Card>
        ))
      )}
      <ComposerSheet
        launch={posting ? { pubkey: posting.author, id: posting.id } : null}
        onOpenChange={(open) => {
          if (!open) setPosting(null);
        }}
        open={posting !== null}
        title={posting ? `Post about ${posting.name}` : "Post"}
      />
    </main>
  );
}
