/**
 * The Money tab of a project: what the project holds and means for a person, what you hold and its Take out (the Back box is
 * in the top of the page, drawn once there),
 * and, for the people who run it, the allowance, Team Shares and the calls waiting for a second signer. Every money screen
 * of the test network says it is play money. Figures here are the server's record with its age; each sheet reads the chain.
 */
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { Banknote } from "lucide-react";
import { nameOf, type ProfileMetadata } from "../../lib/profiles";
import { investingOn } from "../../lib/server";
import type { Project } from "../project/project-record";
import { goToClaims } from "../tasks/chain/holder/claims-anchor";
import { NotesCard } from "../tasks/chain/holder/NotesSection";
import { PlannedSection } from "../tasks/chain/holder/PlannedSection";
import { owedTaskNames, useProjectTasks } from "../tasks/use-tasks";
import { useTeamWallets } from "../team/use-wallets";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import {
  freshnessOf,
  holdingHint,
  type ProjectNumbers,
  type RemovedNumbers,
} from "../money/numbers";
import { OwnershipLine } from "../money/OwnershipLine";
import { withStepKeys } from "../money/numbers-step9";
import { CouncilSection } from "../council/CouncilSection";
import { VoteCard } from "../council/VoteCard";
import { PauseCard } from "../pause/PauseCard";
import { AllowanceSection } from "./AllowanceSection";
import { ChainOnlyShares } from "./ChainOnlyShares";
import { addressNameOf, membersOf } from "./member-names";
import { MoneyFacts, StaleMoney } from "./MoneyFacts";
import { SeatSection } from "../seat/SeatSection";
import { PairWaiting } from "./PairWaiting";
import { PLAY_MONEY_WORDS } from "./pot-words";
import { targetOf } from "./target";
import { TeamSharesSection } from "./TeamSharesSection";
import { usePotWallet } from "./use-pot";
import { YourShares } from "./YourShares";

function PlayMoneyLine() {
  return (
    <p className="text-sm text-muted" data-testid="play-money">
      {PLAY_MONEY_WORDS}
    </p>
  );
}

export function ProjectMoney({
  projectName,
  chainKey,
  numbers,
  loading,
  error,
  onRetry,
  now,
  team,
  profiles,
  project,
}: {
  /** The project, so a draw that pays an accepted task can name the task to the second signer. */
  project?: Project;
  projectName: string;
  /** The chain key the founder's record names, or null. */
  chainKey: string | null;
  numbers: ProjectNumbers | RemovedNumbers | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
  /** The people on the team (the founder first): a Team Share grant can go to them. */
  team: readonly string[];
  profiles: Record<string, ProfileMetadata> | undefined;
}) {
  const investing = investingOn();
  const wallets = useTeamWallets(investing ? [...team] : []).data;
  // The team a grant can go to, each with the wallet they proved is theirs (none: they cannot be granted to yet), and
  // the name for an account's address that every screen here uses (`pot/member-names.ts`).
  const members = membersOf(team, wallets, profiles);
  const nameOfAddress = addressNameOf(members);
  const wallet = usePotWallet(
    numbers && !numbers.removed ? numbers.chainId : undefined,
  );
  // Only a Pair's two signers read waiting calls: only then are the tasks read, to name what a draw pays for.
  const tasksRead = useProjectTasks(
    project ?? null,
    Boolean(numbers && !numbers.removed && numbers.runner.isPair),
  );
  if (loading) return <Card className="h-40 animate-pulse" />;
  if (error)
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          action={
            <Button onClick={onRetry} variant="secondary">
              Try again
            </Button>
          }
          title="The numbers could not be read"
        >
          {readFailureWords(error).text}
        </EmptyState>
        <ChainOnlyShares chainKey={chainKey} projectName={projectName} />
        <OwnershipLine className="text-sm text-muted" />
      </div>
    );
  if (!numbers || numbers.removed)
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          icon={<Banknote size={28} />}
          testId="money-none"
          title={
            numbers?.removed
              ? "Not on the network any more"
              : chainKey === null
                ? "Not open to backers yet"
                : "No numbers yet"
          }
        >
          <p>
            {numbers?.removed
              ? "This project's launch left the network, so it has no money to show."
              : chainKey === null
                ? "Nobody can back this project yet. When its founder launches it, its money shows here."
                : "The server has not read this project's money yet. When it has, it shows here, and until then no figures are shown. This page looks again every few seconds for a couple of minutes; after that, reload it to look again."}
          </p>
        </EmptyState>
        {numbers?.removed ? null : (
          <ChainOnlyShares chainKey={chainKey} projectName={projectName} />
        )}
        <OwnershipLine className="text-sm text-muted" />
      </div>
    );
  // The step 4 and milestone 9 keys are read by the lazy parser this tab already carries (`numbers-step9.ts`): the record
  // keeps them undecoded so the first download is not larger, and they are read here, when this tab opens.
  const record = withStepKeys(numbers);
  const stale = freshnessOf(record, now).level === "stale";
  const target = targetOf(record);
  // What the page already holds about tasks, handed to the Take out sheet as plain values: the sheet never reads it.
  const queue =
    typeof record.tasks === "object" && record.tasks ? record.tasks : null;
  const taskInfo = {
    dueSecs: queue?.limits.dueSecs ?? null,
    ...(queue ? { onWhereToClaim: () => goToClaims() } : {}),
  };
  return (
    <div className="flex flex-col gap-3" data-testid="project-money">
      {mustSayPlayMoney(numbers.playMoney) ? <PlayMoneyLine /> : null}
      {stale ? (
        <StaleMoney numbers={record} />
      ) : (
        <MoneyFacts now={now} numbers={record} />
      )}
      {/* Step 4: only a record with a readable stop draws the card; an older one or none draws nothing about it. */}
      {record.pause ? (
        <PauseCard
          holds={
            wallet.address
              ? holdingHint(record, [wallet.address]).listed
              : false
          }
          nameOf={nameOfAddress}
          now={now}
          numbers={record}
          pause={record.pause}
          projectCoordinate={project?.coordinate ?? null}
        />
      ) : null}
      {/* Milestone 9: the card draws only when the record carries an open ballot (or a result still on show). */}
      <VoteCard
        address={wallet.address}
        holds={
          wallet.address ? holdingHint(record, [wallet.address]).listed : false
        }
        nameOf={nameOfAddress}
        now={now}
        numbers={record}
        projectCoordinate={project?.coordinate ?? null}
      />
      <YourShares
        pauseInfo={{
          contract: record.contracts.pause ?? null,
          record: record.pause,
        }}
        projectName={projectName}
        target={target}
        taskInfo={taskInfo}
      />
      <PlannedSection
        now={now}
        numbers={record}
        profiles={profiles}
        project={project ?? null}
      />
      {queue ? (
        <NotesCard
          anchor
          numbers={record}
          project={project ?? null}
          projectKey={numbers.key}
        />
      ) : null}
      {/* Milestone 9: the Council section sits above the runner presses, and draws only for a Council runner. */}
      <CouncilSection
        address={wallet.address}
        nameOf={nameOfAddress}
        now={now}
        numbers={record}
      />
      <AllowanceSection address={wallet.address} now={now} numbers={record} />
      <TeamSharesSection
        address={wallet.address}
        members={members}
        numbers={record}
      />
      <SeatSection
        members={members}
        nameOf={nameOfAddress}
        now={now}
        numbers={record}
        projectName={projectName}
      />
      <PairWaiting
        address={wallet.address}
        nameOf={nameOfAddress}
        numbers={record}
        taskWordsOf={(what) =>
          tasksRead.data?.tasks.find((t) => `0x${t.id}` === what.toLowerCase())
            ?.what ?? null
        }
        tasksFor={(payee, raw) =>
          owedTaskNames(tasksRead.data?.tasks ?? [], payee, raw, (pubkey) =>
            nameOf(profiles, pubkey),
          )
        }
      />
      <OwnershipLine className="text-sm text-muted" />
    </div>
  );
}
