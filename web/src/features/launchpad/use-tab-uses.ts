/**
 * Whether a project uses the parts of its page that are shown only once used (`tabShown` in `lib/launch-tabs.ts`): its
 * list of updates, its boards, and its people and helpers.
 *
 * Each answer is "yes", "no" or "unknown". A read that failed, or was cut short without finding anything, is
 * "unknown", which keeps the tab on the page. A read still on its way is "no" for the moment: the tab appears when the
 * answer comes, instead of showing and then going.
 *
 * The updates are counted from the same read of this project's own records that the update card at the top of the page
 * shows (`useProjectUpdates`), in both forms an update takes. So the card never links to a tab that is not there, and
 * the tab lists what the card counted.
 */

import { useMemo } from "react";

import { useProjectBoardsOf } from "@/features/board/use-project-boards";
import { projectProgress } from "@/features/feed/lib/project-progress";
import { useAgentRoster } from "@/features/fleet/use-agent-roster";
import { useOrgChart } from "@/features/fleet/use-org-chart";
import { useProjectWork } from "@/features/fleet/use-project-work";

import { type LaunchTab, type TabUse, updatesUse } from "./lib/launch-tabs";
import type { Launch } from "./models";
import { useProjectUpdates } from "./use-help-requests";

export function useTabUses(launch: Launch): {
  uses: Partial<Record<LaunchTab, TabUse>>;
  /** How many updates the Updates tab lists, or null while that is not known. */
  updates: number | null;
} {
  const boards = useProjectBoardsOf(launch);
  const org = useOrgChart();
  const roster = useAgentRoster();
  const work = useProjectWork(launch.record);
  const read = useProjectUpdates(launch.record);
  const seats = useMemo(
    () =>
      Object.values(org.byKey).some(
        (node) =>
          node.pubkey === launch.record.author && node.kind === "agent_seat",
      ),
    [org.byKey, launch.record.author],
  );
  // A helper given one of the project's tasks is one of its helpers, seat or no seat.
  const assigned = useMemo(() => {
    const agents = new Set(roster.agents.map((agent) => agent.pubkey));
    return (work.data?.tasks ?? []).some(
      (task) => task.assignee && agents.has(task.assignee),
    );
  }, [roster.agents, work.data]);
  const data = read.data;
  const updates = useMemo(
    () =>
      data
        ? projectProgress(
            [{ record: launch.record, updates: data.updates }],
            data.posts,
          ).length
        : null,
    [data, launch.record],
  );
  return {
    updates,
    uses: {
      updates: updatesUse({
        count: updates,
        failed: read.isError,
        complete: Boolean(data?.complete && !data.postsCut),
      }),
      boards:
        boards.boards.length > 0 ? "yes" : boards.error ? "unknown" : "no",
      agents:
        seats || assigned || launch.record.agent
          ? "yes"
          : org.loadError || roster.loadError || work.isError
            ? "unknown"
            : "no",
    },
  };
}
