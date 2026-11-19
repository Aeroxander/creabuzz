/**
 * LEGACY (reachable only with the legacy-screens flag, `lib/legacy.ts`): the project page's Money tab of the stages-and-
 * rounds design. Reads record version 1. Loaded only when the flag is on.
 */
import { lazy, Suspense } from "react";
import { MoneyTab } from "../features/money/MoneyTab";
import { chainKeyOfProject } from "../features/money/use-money";
import { useProjectNumbers } from "../features/money/use-money-v1";
import type { Project } from "../features/project/project-record";
import type { ProfileMetadata } from "../lib/profiles";

const TeamMoney = lazy(() =>
  import("../features/team/TeamMoney").then((m) => ({ default: m.TeamMoney })),
);
const MarketMoney = lazy(() =>
  import("../features/market/MarketMoney").then((m) => ({
    default: m.MarketMoney,
  })),
);
const LaunchProject = lazy(() =>
  import("../features/team/LaunchProject").then((m) => ({
    default: m.LaunchProject,
  })),
);

export default function LegacyMoneyTab({
  project,
  isFounder,
  team,
  profiles,
}: {
  project: Project;
  isFounder: boolean;
  team: string[];
  profiles: Record<string, ProfileMetadata> | undefined;
}) {
  const read = useProjectNumbers(project);
  const numbers = read.data && !read.data.removed ? read.data : null;
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="flex flex-col gap-3">
      {isFounder && !chainKeyOfProject(project) ? (
        <Suspense fallback={null}>
          <LaunchProject project={project} />
        </Suspense>
      ) : null}
      {numbers ? (
        <Suspense fallback={null}>
          <TeamMoney numbers={numbers} profiles={profiles} team={team} />
          <MarketMoney numbers={numbers} />
        </Suspense>
      ) : null}
      <MoneyTab
        error={read.error}
        loading={read.isPending && read.fetchStatus !== "idle"}
        now={now}
        numbers={read.data}
        onRetry={() => void read.refetch()}
      />
    </div>
  );
}
