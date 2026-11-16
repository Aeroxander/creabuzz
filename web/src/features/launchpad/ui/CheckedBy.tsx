import { useUserNames } from "@/features/profiles/use-profiles";

import {
  type CheckedBy as CheckedByWho,
  checkedBy,
  whoWords,
} from "../lib/task-checks";
import type { TaskView } from "../lib/tasks";
import { AccountAgentBadge } from "./AccountAgentBadge";

/**
 * One line for a piece of work: "Done by Robin · Checked by Sol", or "Done by you · Checked by you" for the founder who
 * checked their own. An agent that did the work has its label right after its name, as part of the same line (one
 * stop for a screen reader, not a second control). An agent is never shown as the checker: it cannot check.
 */
export function CheckedBy({
  task,
  viewer,
  className,
}: {
  task: Pick<TaskView, "helper" | "accepted">;
  viewer: string | null;
  className?: string;
}) {
  const line: CheckedByWho = checkedBy(task, viewer);
  const nameOf = useUserNames(
    [line.done.pubkey, line.checked?.pubkey].filter(
      (pubkey): pubkey is string => typeof pubkey === "string",
    ),
  );
  return (
    <p className={className ?? "text-sm"} data-testid="checked-by">
      Done by {whoWords(line.done, nameOf)}
      {line.done.you ? null : <AccountAgentBadge pubkey={line.done.pubkey} />}
      {line.checked ? ` · Checked by ${whoWords(line.checked, nameOf)}` : null}
    </p>
  );
}
