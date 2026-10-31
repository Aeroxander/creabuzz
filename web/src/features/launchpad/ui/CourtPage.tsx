import { useLocation } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { defaultChainPreset } from "../chain-config";
import {
  encodeDrip,
  encodeStake,
  encodeUnstake,
  encodeWithdrawCourt,
  MAX_CASES,
} from "@creaton/core/launchpad/court.ts";
import { owedLine, seatProblem, stakeLine } from "../lib/court-copy";
import { formatUnits, parseUnits } from "@creaton/core/launchpad/daoActions.ts";
import { encodeApproveBounty } from "@creaton/core/launchpad/workBounty.ts";
import { useChainSend } from "../use-chain-send";
import { COURT_QUERY, type CourtPageData, useCourt } from "../use-court";
import { FailureNote, WalletStrip } from "./account-widgets";
import { CourtCaseCard } from "./CourtCaseCard";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * The $CREATE court (N7): jurors stake CREATE to be drawn for disputes about work, judged against the words written
 * before the work started. Jurors who vote with the final ruling are paid; those who vote against it or never open their
 * vote lose part of their stake. Anyone can move a case on once its time is up.
 */
export function CourtPage() {
  const sender = useChainSend(defaultChainPreset().chainId, COURT_QUERY);
  const [limit, setLimit] = useState(MAX_CASES);
  // A link to one case (`/court#case-7`, from a bond or a bounty) reads it however old it is.
  const hash = useLocation({ select: (l) => l.hash });
  const linked = /^case-(\d{1,20})$/.exec(hash ?? "");
  const include = linked ? BigInt(linked[1]) : null;
  const { court, query } = useCourt(sender.wallet.address, limit, include);
  const data = query.data;
  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded || include === null) return;
    document
      .getElementById(`case-${include}`)
      ?.scrollIntoView({ block: "start" });
  }, [loaded, include]);
  // The cases you were drawn in come first, newest first within each group.
  const cases = data
    ? [
        ...data.cases.filter((c) => c.assigned),
        ...data.cases.filter((c) => !c.assigned),
      ]
    : [];
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <header>
        <h1 className="text-xl font-semibold">Court</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          People stake CREATE to judge disputes about work, against the words
          written before it started. Jurors who vote with the final ruling are
          paid; those who vote against it, or never open their vote, lose part
          of their stake.
        </p>
      </header>
      {!court ? (
        <Card className="p-4 text-sm" data-testid="court-none">
          There is no court on this network.
        </Card>
      ) : query.isError ? (
        <Card className="p-4 text-sm" role="status">
          The network did not answer, so the court can&apos;t be shown.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </Card>
      ) : !data ? (
        <Card className="p-4 text-sm text-muted-foreground" role="status">
          Reading…
        </Card>
      ) : (
        <>
          <JurorCard
            busy={sender.busy}
            data={data}
            gate={sender.gate}
            onSend={sender.send}
          />
          <section
            aria-labelledby="court-cases"
            className="flex flex-col gap-3"
          >
            <h2 className="text-base font-semibold" id="court-cases">
              Cases
            </h2>
            {data.cases.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="court-no-cases"
              >
                No cases yet. A case opens when someone appeals a bounty.
              </p>
            ) : (
              cases.map((c) => (
                <CourtCaseCard
                  busy={sender.busy}
                  data={data}
                  gate={sender.gate}
                  key={c.id.toString()}
                  kase={c}
                  onSend={sender.send}
                  wallet={sender.wallet}
                />
              ))
            )}
            {data.truncated ? (
              <Button
                className="self-start"
                data-testid="court-older"
                disabled={query.isFetching}
                onClick={() => setLimit((was) => was + MAX_CASES)}
                size="sm"
                type="button"
                variant="outline"
              >
                {query.isFetching ? "Reading…" : "Show older cases"}
              </Button>
            ) : null}
          </section>
        </>
      )}
      <WalletStrip testIdPrefix="court" wallet={sender.wallet} />
      {sender.failure ? (
        <FailureNote message={sender.failure} testId="court-failure" />
      ) : null}
    </div>
  );
}

function JurorCard({
  data,
  busy,
  gate,
  onSend,
}: {
  data: CourtPageData;
  busy: string | null;
  gate: string | null;
  onSend: Send;
}) {
  const id = useId();
  const [amountText, setAmountText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const side = data.wallet;
  const juror = data.juror;
  const blocked = busy !== null || gate !== null;
  const canDrip =
    data.faucet !== null &&
    side !== null &&
    side.nextDrip !== null &&
    data.now >= side.nextDrip;
  const owed = juror !== null && (juror.owedFee > 0n || juror.owedStake > 0n);

  const amount = (): bigint | null => {
    setProblem(null);
    try {
      return parseUnits(amountText, 18, "amount", "The amount");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const stake = async () => {
    const value = amount();
    if (value === null || !side) return;
    if (value === 0n || value > side.create) {
      setProblem(`You have ${formatUnits(side.create, 18)} CREATE to stake.`);
      return;
    }
    const seats = seatProblem(
      "stake",
      juror?.staked ?? 0n,
      value,
      data.seatStake,
    );
    if (seats) {
      setProblem(seats);
      return;
    }
    if (side.createAllowance < value) {
      const allowed = await onSend(
        "court-allow",
        data.stakeToken,
        encodeApproveBounty(data.court, value),
      );
      if (!allowed) return;
    }
    if (await onSend("court-stake", data.court, encodeStake(value))) {
      setAmountText("");
    }
  };
  const unstake = async () => {
    const value = amount();
    if (value === null || !juror) return;
    const free = juror.staked - juror.locked;
    if (value === 0n || value > free) {
      setProblem(
        `You can take out ${formatUnits(free, 18)} CREATE: the rest is held by open cases.`,
      );
      return;
    }
    const seats = seatProblem("unstake", juror.staked, value, data.seatStake);
    if (seats) {
      setProblem(seats);
      return;
    }
    if (await onSend("court-unstake", data.court, encodeUnstake(value))) {
      setAmountText("");
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="court-juror">
      <h2 className="text-base font-semibold">Judge cases</h2>
      <p className="text-sm text-muted-foreground">
        Each {formatUnits(data.seatStake, 18)} CREATE you stake is one seat.
        Seats are drawn at random by stake; a seat on a case is held until it is
        settled.
      </p>
      {side ? (
        <>
          <p className="text-sm" data-testid="court-balance">
            You hold {formatUnits(side.create, 18)} CREATE.
          </p>
          <p className="text-sm" data-testid="court-stake">
            {stakeLine(
              juror?.staked ?? 0n,
              juror?.locked ?? 0n,
              data.seatStake,
            )}
          </p>
          {owed && juror ? (
            <p className="text-sm" data-testid="court-owed">
              {owedLine(juror.owedFee, juror.owedStake)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor={`${id}-amount`}>
                CREATE
              </label>
              <Input
                className="w-32"
                data-testid="court-amount"
                id={`${id}-amount`}
                inputMode="decimal"
                onChange={(e) => setAmountText(e.target.value)}
                placeholder="300"
                value={amountText}
              />
            </div>
            <Button
              data-testid="court-stake-button"
              disabled={blocked || !amountText.trim()}
              onClick={() => void stake()}
              size="sm"
              type="button"
            >
              {busy === "court-allow"
                ? "Allowing…"
                : busy === "court-stake"
                  ? "Staking…"
                  : "Stake"}
            </Button>
            <Button
              data-testid="court-unstake-button"
              disabled={blocked || !amountText.trim() || !juror?.staked}
              onClick={() => void unstake()}
              size="sm"
              type="button"
              variant="outline"
            >
              Take out
            </Button>
          </div>
          {problem ? (
            <p
              className="text-sm text-red-700 dark:text-red-300"
              data-testid="court-problem"
              role="alert"
            >
              {problem}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {data.faucet ? (
              <Button
                data-testid="court-drip"
                disabled={blocked || !canDrip}
                onClick={() =>
                  void onSend("court-drip", data.faucet as string, encodeDrip())
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {canDrip
                  ? "Get 1,000 test CREATE"
                  : "Test CREATE again tomorrow"}
              </Button>
            ) : null}
            {owed ? (
              <Button
                data-testid="court-withdraw"
                disabled={blocked}
                onClick={() =>
                  void onSend(
                    "court-withdraw",
                    data.court,
                    encodeWithdrawCourt(),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Withdraw what I'm owed
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </Card>
  );
}
