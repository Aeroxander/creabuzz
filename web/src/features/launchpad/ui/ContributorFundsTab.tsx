/**
 * Funds, for a contributor project (D111): what its DAO holds, how a holder leaves with their share, and, once the DAO
 * voted for it, how a member sells Shares to someone who wants in (N5).
 *
 * A contributor project has no sale, but its DAO is an ordinary one: anyone can send it money, holders vote on spending
 * it on the Decisions tab, and anyone holding Shares can give them up for their part of what it holds. So the money and
 * the exit stay reachable, even when the balances are zero or cannot be read; the sale's panels (the graduation split,
 * the price floor, the plan priced from the terms) do not apply and are not shown. The DAO is the one the contributor kit
 * launched, checked against the kit's own event: the record alone only claims it.
 */

import { useQuery } from "@tanstack/react-query";

import { Card } from "@/shared/ui/card";

import { ethGetBalance, erc20BalanceOf, getRpcEndpoint } from "../chain";
import { localUsdcAddress } from "../chain-config";
import { formatUnits } from "../lib/dao-actions";
import type { DaoBinding } from "../lib/org-money";
import type { Launch } from "../models";
import { useContributorProvenance } from "../use-contributor-provenance";
import { DelegationCard } from "./DelegationCard";
import { Figure } from "./Figure";
import { MatchedExitCard } from "./MatchedExitCard";
import { PayoutsCard } from "./PayoutsCard";
import { RagequitPanel } from "./RagequitPanel";
import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";

/** One currency the DAO may hold: USDC where this network has it, and ETH. */
function Held({
  dao,
  token,
  symbol,
  decimals,
}: {
  dao: string;
  /** The ERC-20, or null for ETH. */
  token: string | null;
  symbol: string;
  decimals: number;
}) {
  const held = useQuery({
    queryKey: ["launchpad", "contributor-funds", dao, token ?? "eth"],
    queryFn: () =>
      token
        ? erc20BalanceOf(getRpcEndpoint(), token, dao)
        : ethGetBalance(getRpcEndpoint(), dao).catch(() => null),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const value = held.data;
  return (
    <Figure
      label={`${symbol} held`}
      note={
        value === null || held.isError
          ? "Could not be read from the network"
          : undefined
      }
      testId={`contributor-funds-${symbol.toLowerCase()}`}
      value={
        value === null || value === undefined
          ? "—"
          : `${formatUnits(value, decimals)} ${symbol}`
      }
    />
  );
}

export function ContributorFundsTab({
  launch,
  dao,
}: {
  launch: Launch;
  dao: string;
}) {
  const chainId = launch.record.chainId ?? null;
  const { provenance, kit } = useContributorProvenance(chainId, dao);
  const usdc = usdcAddress(chainId, localUsdcAddress());

  if (provenance !== "kit") {
    return (
      <Card className="max-w-3xl p-4" data-testid="contributor-funds">
        <h2 className="text-base font-semibold">Funds</h2>
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="contributor-funds-unchecked"
          role="status"
        >
          {provenance === "reading"
            ? "Checking this project's DAO…"
            : "This project's DAO could not be checked against the contributor kit, so its money and the way to leave are not shown here."}
        </p>
      </Card>
    );
  }

  const binding: DaoBinding = {
    dao,
    source: "contributor-kit",
    ref: kit ?? "",
  };
  // The exit pays out each currency it names: USDC where the network has it, beside ETH.
  const exitRecord = { ...launch.record, currency: usdc };
  return (
    <div
      className="grid max-w-3xl grid-cols-1 gap-4"
      data-testid="contributor-funds"
    >
      <Card className="p-4">
        <h2 className="text-base font-semibold">Funds</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This project sold nothing, but anyone can send money to its DAO.
          Holders decide on the Decisions tab what it is spent on, and anyone
          holding Shares can leave with their part of it.
        </p>
        <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
          {usdc ? (
            <Held dao={dao} decimals={6} symbol="USDC" token={usdc} />
          ) : null}
          <Held dao={dao} decimals={18} symbol="ETH" token={null} />
        </div>
      </Card>
      <RagequitPanel
        chainId={Number(chainId ?? "") || 0}
        daoBinding={binding}
        record={exitRecord}
      />
      <MatchedExitCard dao={dao} />
      <PayoutsCard dao={dao} />
      <DelegationCard
        author={launch.record.author}
        dao={dao}
        launchId={launch.record.id}
        members={[]}
      />
    </div>
  );
}
