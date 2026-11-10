import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { Need } from "../lib/project-state";
import type { LaunchRecord } from "../models";

/**
 * The one place a need leads: the task, the request or the project's page where it is acted on. Shared by "Your
 * projects" and Home's next step, so both send a person to the same place for the same thing.
 */
export function NeedLink({
  need,
  project,
  className,
  testId,
  children,
}: {
  need: Need;
  project: Pick<LaunchRecord, "id" | "author">;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const hash =
    need.kind === "check" ||
    need.kind === "task-yes" ||
    need.kind === "task-due"
      ? `task-${need.taskId}`
      : need.kind === "offers"
        ? `update-${need.updateId}`
        : undefined;
  return (
    <Link
      className={className}
      data-testid={testId}
      hash={hash}
      params={{ launchId: project.id }}
      search={{ author: project.author }}
      to="/launchpad/$launchId"
    >
      {children}
    </Link>
  );
}
