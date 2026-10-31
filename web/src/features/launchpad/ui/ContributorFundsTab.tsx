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
import { useRef } from "react";

import { pickUserName } from "@/features/profiles/lib/user-label";
import { useProfiles } from "@/features/profiles/use-profiles";
import { Card } from "@/shared/ui/card";

import { ethGetBalance, erc20BalanceOf, getRpcEndpoint } from "../chain";
import { localUsdcAddress } from "../chain-config";
import { formatUnits } from "../lib/dao-actions";
import { delegateChoices } from "../lib/delegate-choices";
import type { DaoBinding } from "../lib/org-money";
import { pubkeysToName } from "../lib/record-people";
import type { Launch } from "../models";
import { useActingAccount } from "../use-acting-account";
import { useContributorProvenance } from "../use-contributor-provenance";
import { usePeopleWithWallets } from "../use-people";
import { useDaoHolders } from "../use-work";
import { DelegationCard } from "./DelegationCard";
import { Figure } from "./Figure";
import { FundingCard } from "./FundingCard";
import { WeeklyRoundsCard } from "./WeeklyRoundsCard";
import { PayoutsCard } from "./PayoutsCard";
import { RagequitPanel } from "./RagequitPanel";
import { AddressRow } from "./account-widgets";
import { SHOWN_HOLDERS } from "../lib/holders-read";
import { plainNetworkName } from "../lib/test-network";
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
  // Who a holder can hand their votes to from the list: the named people who hold Shares (D144).
  const holders = useDaoHolders(dao);
  const acting = useActingAccount().address;
  const wallets = usePeopleWithWallets();
  const holderAddresses = holders.data?.holders.map((h) => h.holder) ?? [];
  const profiles = useProfiles(
    pubkeysToName(wallets.data ?? [], holderAddresses),
  );
  const delegates = delegateChoices({
    holders: holderAddresses,
    people: wallets.data ?? [],
    nameOf: (pubkey) => pickUserName(profiles.data?.[pubkey]),
    // Never the DAO, and never the account choosing: handing votes to oneself is the card's own "Back to myself".
    exclude: [dao, acting],
  });

  // Read before the early return below: hooks keep their order when the DAO check finishes.
  const shownOnce = useRef(false);

  if (provenance !== "kit") {
    return (
      <Card className="p-4" data-testid="contributor-funds">
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
  // Leaving and handing on votes are for people holding Shares: shown unless the full list of holders is known and the
  // acting account is not on it (a list cut at the largest few, or not read, never hides them).
  const fullList =
    holders.data?.accounted === true &&
    !holders.data.tooMany &&
    holders.data.found <= SHOWN_HOLDERS;
  const holdsNow =
    !fullList ||
    (acting !== null &&
      holderAddresses.some((h) => h.toLowerCase() === acting.toLowerCase()));
  // Once shown, the panels stay for this visit: leaving takes the person off the list of holders, and the panel (with
  // its open dialog, which says the exit landed) must not vanish under them when that list is read again.
  if (holdsNow) shownOnce.current = true;
  const holdsShares = holdsNow || shownOnce.current;
  return (
    <div
      className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start"
      data-testid="contributor-funds"
    >
      <Card className="p-4">
        <h2 className="text-base font-semibold">Funds</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Shareholders decide on the Decisions tab what this money is spent on,
          and anyone holding Shares can leave with their part of it.
        </p>
        <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
          {usdc ? (
            <Held dao={dao} decimals={6} symbol="USDC" token={usdc} />
          ) : null}
          <Held dao={dao} decimals={18} symbol="ETH" token={null} />
        </div>
        <div data-testid="contributor-funds-send">
          <h3 className="mt-4 text-sm font-semibold">
            Send money to this project
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Anyone can send {usdc ? "USDC or ETH" : "ETH"} to its DAO, on{" "}
            {plainNetworkName(chainId)} only. Money sent on another network is
            lost.
          </p>
          <AddressRow
            copyLabel="Copy the DAO's address"
            label="The DAO's address"
            value={dao}
          />
        </div>
      </Card>
      {holdsShares ? (
        <RagequitPanel
          chainId={Number(chainId ?? "") || 0}
          daoBinding={binding}
          followActingAccount
          record={exitRecord}
        />
      ) : null}
      <FundingCard dao={dao} />
      <WeeklyRoundsCard dao={dao} />
      <PayoutsCard dao={dao} />
      {holdsShares ? (
        <DelegationCard
          author={launch.record.author}
          chainId={Number(chainId ?? "") || 0}
          dao={dao}
          followActingAccount
          launchId={launch.record.id}
          members={delegates}
        />
      ) : null}
    </div>
  );
}
