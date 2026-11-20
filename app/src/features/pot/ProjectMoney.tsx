/**
 * The Money tab of a project: what the project holds and means for a person, the Back box, what you hold and its Take out,
 * and, for the people who run it, the allowance, Team Shares and the calls waiting for a second signer. Every money screen
 * of the test network says it is play money. Figures here are the server's record with its age; each sheet reads the chain.
 */
import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { Banknote } from "lucide-react";
import { nameOf, type ProfileMetadata } from "../../lib/profiles";
import { investingOn } from "../../lib/server";
import type { Project } from "../project/project-record";
import { owedTaskNames, useProjectTasks } from "../tasks/use-tasks";
import { useTeamWallets } from "../team/use-wallets";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import {
  freshnessOf,
  type ProjectNumbers,
  type RemovedNumbers,
} from "../money/numbers";
import { OwnershipLine } from "../money/OwnershipLine";
import { AllowanceSection } from "./AllowanceSection";
import { BackCard } from "./BackCard";
import { ChainOnlyShares } from "./ChainOnlyShares";
import type { GrantMember } from "./GrantSheet";
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
  // The team a grant can go to, each with the wallet they proved is theirs (none: they cannot be granted to yet).
  const members: GrantMember[] = team.map((pubkey) => {
    const wallet = wallets?.[pubkey];
    return {
      pubkey,
      name: nameOf(profiles, pubkey),
      address: wallet?.state === "linked" ? wallet.address : null,
    };
  });
  // A name for an account's address, for the sentences a second signer reads.
  const nameOfAddress = (address: string) =>
    members.find((m) => m.address === address.toLowerCase())?.name ??
    `${address.slice(0, 6)}…${address.slice(-4)}`;
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
  const stale = freshnessOf(numbers, now).level === "stale";
  const target = targetOf(numbers);
  return (
    <div className="flex flex-col gap-3" data-testid="project-money">
      {mustSayPlayMoney(numbers.playMoney) ? <PlayMoneyLine /> : null}
      {stale ? (
        <StaleMoney numbers={numbers} />
      ) : (
        <MoneyFacts now={now} numbers={numbers} />
      )}
      {stale ? (
        <Card data-testid="back-paused">
          <p className="text-sm">
            Backing waits until the numbers are fresh again. Taking your money
            out does not wait.
          </p>
        </Card>
      ) : (
        <BackCard now={now} numbers={numbers} projectName={projectName} />
      )}
      <YourShares projectName={projectName} target={target} />
      <AllowanceSection address={wallet.address} now={now} numbers={numbers} />
      <TeamSharesSection
        address={wallet.address}
        members={members}
        numbers={numbers}
      />
      <SeatSection
        members={members}
        nameOf={nameOfAddress}
        now={now}
        numbers={numbers}
        projectName={projectName}
      />
      <PairWaiting
        address={wallet.address}
        nameOf={nameOfAddress}
        numbers={numbers}
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
