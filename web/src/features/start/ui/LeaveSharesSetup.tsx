/**
 * The way out of setting up Shares, for a page that cannot go on (this server cannot reach its network) or has nobody to
 * pick as a reviewer: back to the project the founder came from, or to Start when they came with none. Shares are not
 * needed to begin, so this is a real way forward, never a dead end.
 */

import { Link } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";

import type { IdeaHandoff } from "../lib/from-idea";

export function LeaveSharesSetup({
  project,
  testId,
}: {
  /** The founder's own project this setup was handed over from, when there is one. */
  project: Pick<IdeaHandoff, "id" | "author"> | null;
  testId: string;
}) {
  return (
    <Button
      asChild
      className="max-sm:h-11"
      data-testid={testId}
      size="sm"
      variant="outline"
    >
      {project ? (
        <Link
          params={{ launchId: project.id }}
          search={{ author: project.author }}
          to="/launchpad/$launchId"
        >
          Back to my project
        </Link>
      ) : (
        <Link to="/start">Back to Start</Link>
      )}
    </Button>
  );
}
