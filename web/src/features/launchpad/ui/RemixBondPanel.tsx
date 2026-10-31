import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { defaultChainPreset } from "../chain-config";
import { formatUnits, parseUnits } from "@creaton/core/launchpad/daoActions.ts";
import {
  bondActions,
  encodeOpenBondCase,
  encodePayParent,
  encodePostBond,
  encodeReleaseBond,
} from "@creaton/core/launchpad/remixBond.ts";
import { encodeApproveBounty } from "@creaton/core/launchpad/workBounty.ts";
import type { Launch } from "../models";
import { useChainSend } from "../use-chain-send";
import { REMIX_BOND_QUERY, useRemixBond } from "../use-remix-bond";
import { FailureNote } from "@/shared/ui/failure-note";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/**
 * A remix's bond to its parent (N12, test networks): the project built on another posts CREATE for a term against the
 * parent's remix terms; anyone can take it to the court; an upheld case makes it the parent's; otherwise it comes back.
 */
export function RemixBondPanel({
  remix,
  parent,
}: {
  remix: Launch;
  parent: Launch;
}) {
  const id = useId();
  const sender = useChainSend(defaultChainPreset().chainId, REMIX_BOND_QUERY);
  const coordinate = `37001:${remix.record.author}:${remix.record.id}`;
  const { contract, query } = useRemixBond(
    remix,
    parent,
    sender.wallet.address,
  );
  const [amountText, setAmountText] = useState("");
  const [daysText, setDaysText] = useState("365");
  const [problem, setProblem] = useState<string | null>(null);
  if (!contract) return null;
  const data = query.data;
  const parentDao = parent.record.treasury ?? "";
  const blocked = sender.busy !== null || sender.gate !== null;
  const bond = data?.bond ?? null;
  const can = bond && data ? bondActions(bond, data.now) : null;
  const terms = parent.record.remixTerms?.asks ?? "";

  const post = async () => {
    setProblem(null);
    if (!data?.wallet) return;
    let amount: bigint;
    let call: string;
    try {
      amount = parseUnits(amountText, 18, "amount", "The bond");
      call = encodePostBond({
        remix: coordinate,
        parent: `37001:${parent.record.author}:${parent.record.id}`,
        parentDao,
        terms,
        amount,
        days: Number(daysText.trim()),
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    if (amount > data.wallet.create) {
      setProblem(`You hold ${formatUnits(data.wallet.create, 18)} CREATE.`);
      return;
    }
    if (data.wallet.createAllowance < amount) {
      const allowed = await sender.send(
        "bond-allow",
        data.create,
        encodeApproveBounty(contract, amount),
      );
      if (!allowed) return;
    }
    await sender.send("bond-post", contract, call);
  };
  const openCase = async () => {
    if (!bond || !data?.wallet) return;
    if (data.wallet.feeAllowance < data.fee) {
      const allowed = await sender.send(
        "bond-case-allow",
        data.feeToken,
        encodeApproveBounty(contract, data.fee),
      );
      if (!allowed) return;
    }
    await sender.send("bond-case", contract, encodeOpenBondCase(bond.id));
  };

  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="remix-bond">
      {query.isError ? (
        <p className="text-muted-foreground" role="status">
          The bond could not be read.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : !data ? null : bond ? (
        <>
          <p data-testid="remix-bond-line">
            {bond.state === "held"
              ? `This project posted a bond of ${formatUnits(bond.amount, 18)} CREATE for ${parent.record.name}, held until ${date(bond.releasesAt)}.`
              : bond.state === "forfeited" || bond.state === "paid"
                ? `The court found this project broke ${parent.record.name}'s terms: its ${formatUnits(bond.amount, 18)} CREATE bond went to ${parent.record.name}.`
                : `Its bond of ${formatUnits(bond.amount, 18)} CREATE was returned.`}
          </p>
          {bond.openCase !== 0 ? (
            <Link
              className="underline"
              data-testid="remix-bond-case"
              hash={`case-${bond.openCase}`}
              to="/court"
            >
              The court is looking at it
            </Link>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {can?.openCase && sender.wallet.address ? (
              <Button
                data-testid="remix-bond-open-case"
                disabled={blocked}
                onClick={() => void openCase()}
                size="sm"
                type="button"
                variant="outline"
              >
                It broke the terms: ask the court ({formatUnits(data.fee, 6)}{" "}
                USDC)
              </Button>
            ) : null}
            {can?.release ? (
              <Button
                data-testid="remix-bond-release"
                disabled={blocked}
                onClick={() =>
                  void sender.send(
                    "bond-release",
                    contract,
                    encodeReleaseBond(bond.id),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Return the bond
              </Button>
            ) : null}
            {can?.payParent ? (
              <Button
                data-testid="remix-bond-pay-parent"
                disabled={blocked}
                onClick={() =>
                  void sender.send(
                    "bond-pay",
                    contract,
                    encodePayParent(bond.id),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Send it to {parent.record.name}
              </Button>
            ) : null}
          </div>
        </>
      ) : data.founder === null ? (
        <p className="text-muted-foreground" data-testid="remix-bond-none">
          No bond yet. Only the project&apos;s founder can post one.
        </p>
      ) : sender.wallet.address?.toLowerCase() !== data.founder ? (
        <p className="text-muted-foreground" data-testid="remix-bond-none">
          No bond yet. The project&apos;s founder can post one from their
          wallet.
        </p>
      ) : data.wallet && parentDao ? (
        <div className="flex flex-col gap-2" data-testid="remix-bond-form">
          <p className="text-muted-foreground">
            Post a bond in CREATE for {parent.record.name}: if the court finds
            this project broke its terms, the bond is theirs.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor={`${id}-amount`}>
                CREATE
              </label>
              <Input
                className="w-28"
                data-testid="remix-bond-amount"
                id={`${id}-amount`}
                inputMode="decimal"
                onChange={(e) => setAmountText(e.target.value)}
                placeholder="500"
                value={amountText}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor={`${id}-days`}>
                Held for (days)
              </label>
              <Input
                className="w-24"
                data-testid="remix-bond-days"
                id={`${id}-days`}
                inputMode="numeric"
                onChange={(e) => setDaysText(e.target.value)}
                value={daysText}
              />
            </div>
            <Button
              data-testid="remix-bond-post"
              disabled={blocked || !amountText.trim()}
              onClick={() => void post()}
              size="sm"
              type="button"
            >
              Post the bond
            </Button>
          </div>
        </div>
      ) : null}
      {problem ? (
        <p
          className="text-red-700 dark:text-red-300"
          data-testid="remix-bond-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {sender.failure ? (
        <FailureNote message={sender.failure} testId="remix-bond-failure" />
      ) : null}
    </div>
  );
}
