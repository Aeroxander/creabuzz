/**
 * LEGACY (reachable only with the legacy-screens flag, `lib/legacy.ts`): the actions beside a teammate on the People
 * tab (give Shares) and the person's backing receipts on You and Home's open rounds. Loaded only when the flag is on.
 */
import { lazy, Suspense } from "react";
import { OpenRounds } from "../features/money/OpenRounds";
import { Receipts } from "../features/money/Receipts";
import { useProjectNumbers } from "../features/money/use-money-v1";
import type { Project } from "../features/project/project-record";

const MemberActions = lazy(() =>
  import("../features/team/MemberActions").then((m) => ({
    default: m.MemberActions,
  })),
);

/** The actions beside one teammate. */
export function LegacyMemberActions({
  project,
  name,
  pubkey,
  team,
}: {
  project: Project;
  name: string;
  pubkey: string;
  team: string[];
}) {
  const read = useProjectNumbers(project);
  const numbers = read.data && !read.data.removed ? read.data : null;
  if (!numbers) return null;
  return (
    <Suspense fallback={null}>
      <MemberActions
        name={name}
        numbers={numbers}
        pubkey={pubkey}
        team={team}
      />
    </Suspense>
  );
}

/** Home's open backing rounds. */
export function LegacyOpenRounds({
  projects,
}: {
  projects: readonly Project[];
}) {
  return <OpenRounds projects={projects} />;
}

/** You: the person's receipts from backing rounds. */
export function LegacyReceipts() {
  return <Receipts />;
}
