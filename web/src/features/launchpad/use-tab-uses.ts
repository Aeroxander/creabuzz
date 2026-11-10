/**
 * Whether a project uses the parts of its page that are shown only once used (`tabShown` in `lib/launch-tabs.ts`): its
 * list of updates, its boards, and its people and helpers.
 *
 * Each answer is "yes", "no" or "unknown". A read that failed is "unknown", which keeps the tab on the page. A read
 * still on its way is "no" for the moment: the tab appears when the answer comes, instead of showing and then going.
 */

import { useMemo } from "react";

import { useProjectBoardsOf } from "@/features/board/use-project-boards";
import { projectProgress } from "@/features/feed/lib/project-progress";
import { useOrgChart } from "@/features/fleet/use-org-chart";

import type { LaunchTab, TabUse } from "./lib/launch-tabs";
import type { Launch } from "./models";

export function useTabUses(launch: Launch): Partial<Record<LaunchTab, TabUse>> {
  const boards = useProjectBoardsOf(launch);
  const org = useOrgChart();
  const seats = useMemo(
    () =>
      Object.values(org.byKey).some(
        (node) =>
          node.pubkey === launch.record.author && node.kind === "agent_seat",
      ),
    [org.byKey, launch.record.author],
  );
  const updates = useMemo(() => projectProgress([launch], []).length, [launch]);
  return {
    updates: updates > 0 ? "yes" : "no",
    boards: boards.boards.length > 0 ? "yes" : boards.error ? "unknown" : "no",
    agents:
      seats || launch.record.agent ? "yes" : org.loadError ? "unknown" : "no",
  };
}
