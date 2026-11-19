/**
 * LEGACY (reachable only with the legacy-screens flag, `lib/legacy.ts`): what the project page showed at the top while
 * money ran on stages and rounds: the stage line, backing a round, opening one, the market, and Team. It reads record
 * version 1, which the server no longer publishes. Loaded only when the flag is on.
 */
import { lazy, Suspense } from "react";
import { BackBox } from "../features/money/BackBox";
import { OpenBacking } from "../features/money/OpenBacking";
import { anyRoundUnclosed, openRound } from "../features/money/numbers-v1";
import { useProjectNumbers } from "../features/money/use-money-v1";
import { useWalletAddress } from "../features/money/use-money";
import { currentStage, StageLine } from "../features/project/StageLine";
import type { Project } from "../features/project/project-record";
import type { ProfileMetadata } from "../lib/profiles";

const MarketTop = lazy(() =>
  import("../features/market/MarketTop").then((m) => ({
    default: m.MarketTop,
  })),
);
const TeamTop = lazy(() =>
  import("../features/team/TeamTop").then((m) => ({ default: m.TeamTop })),
);

export default function LegacyProjectTop({
  project,
  isFounder,
  team,
  accepted,
  profiles,
}: {
  project: Project;
  isFounder: boolean;
  team: string[];
  accepted: number;
  profiles: Record<string, ProfileMetadata> | undefined;
}) {
  const read = useProjectNumbers(project);
  const numbers = read.data && !read.data.removed ? read.data : null;
  const address = useWalletAddress().data ?? null;
  const now = Math.floor(Date.now() / 1000);
  const round = numbers ? openRound(numbers, now) : null;
  const money = numbers
    ? { stage: numbers.stage.name, raised: numbers.raised.total }
    : null;
  const canOpen =
    numbers !== null &&
    isFounder &&
    !anyRoundUnclosed(numbers) &&
    numbers.raised.left > 0n &&
    !numbers.clock.woundDown &&
    ["solo", "backed"].includes(numbers.stage.name);
  return (
    <>
      <StageLine
        investing
        money={money}
        stage={currentStage(accepted, money)}
      />
      {numbers && round ? (
        <BackBox
          now={now}
          numbers={numbers}
          primary
          projectName={project.name}
          round={round}
        />
      ) : null}
      {numbers && canOpen ? (
        <OpenBacking address={address} numbers={numbers} />
      ) : null}
      {numbers ? (
        <Suspense fallback={null}>
          <MarketTop numbers={numbers} />
          <TeamTop
            founder={project.author}
            numbers={numbers}
            profiles={profiles}
            team={team}
          />
        </Suspense>
      ) : null}
    </>
  );
}
