import { Coins, DoorOpen, Vote } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { Meter } from "@/shared/ui/meter";
import { MoreInfo } from "@/shared/ui/more-info";
import { defaultChainPreset } from "../chain-config";
import { raisesOffered } from "../lib/raises-offered";
import {
  beforeYouBuy,
  exitFeeLine,
  fundingStateLine,
  instrumentLine,
  soldLine,
} from "../lib/funding-copy";
import {
  encodeFinishFunding,
  encodeOpenFundingRound,
} from "@creaton/core/launchpad/weeklyRounds.ts";
import { useChainSend } from "../use-chain-send";
import { FUNDING_QUERY, useFunding } from "../use-funding";
import { FailureNote, WalletStrip } from "./account-widgets";
import { FundingFlagForm } from "./FundingFlagForm";
import { RoundClaims } from "./RoundClaims";
import { RoundPanel } from "./WeeklyRoundsCard";

/**
 * Funding the project (D133), on a contributor project's Funds tab: the funding terms the DAO published (what buyers get,
 * the most it can ever sell, how much has sold), the sale open now, and its funding rounds, where people bid for the new
 * units and every payment goes to the treasury. Shown where this build names the weekly rounds, which the sales use, and
 * offers raises: selling new units is one, so a contributor-only build shows none of it and reads nothing for it.
 */
export function FundingCard({ dao }: { dao: string }) {
  if (!raisesOffered()) return null;
  return <FundingTerms dao={dao} />;
}

function FundingTerms({ dao }: { dao: string }) {
  const sender = useChainSend(defaultChainPreset().chainId, FUNDING_QUERY);
  const { rounds, query } = useFunding(dao, sender.wallet.address);
  const data = query.data;
  if (!rounds || data === null) return null;
  const blocked = sender.busy !== null || sender.gate !== null;
  const round = data?.funding.round ?? null;
  const roundOver =
    round === null || round.phase === "settled" || round.phase === "void";
  const canOpen =
    data !== undefined &&
    data.phase === "selling" &&
    data.roundsOn &&
    roundOver &&
    data.now >= data.funding.nextOpensAt;

  return (
    <Card className="p-4" data-testid="funding">
      <h2 className="text-base font-semibold">Funding the project</h2>
      {query.isError ? (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          The network did not answer, so funding can&apos;t be shown.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : data === undefined ? (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          Reading…
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-testid="funding-state">
            {fundingStateLine(data.phase, data.terms)}
          </p>
          {data.terms.published ? (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Chip icon={data.terms.asShares ? Vote : Coins}>
                  <span data-testid="funding-instrument">
                    {instrumentLine(data.terms.asShares)}
                  </span>
                </Chip>
                <Chip icon={DoorOpen}>
                  <span data-testid="funding-exit-fee">
                    {exitFeeLine(data.terms.exitFeeBps)}
                  </span>
                </Chip>
              </div>
              <div>
                <Meter
                  label="Sold of the current funding limit"
                  max={data.terms.cap}
                  value={data.terms.sold}
                />
                <p
                  className="mt-1 text-xs text-muted-foreground"
                  data-testid="funding-sold"
                >
                  {soldLine(data.terms)}
                </p>
              </div>
              <FundingFlagForm
                blocked={blocked}
                busy={sender.busy}
                dao={dao}
                onSend={sender.send}
                terms={data.terms.contract}
                watched={data.terms.watched}
              />
            </div>
          ) : null}
          {data.phase === "selling" ? (
            <div
              className="mt-2 rounded-lg border border-border/60 p-3 text-sm"
              data-testid="funding-before-you-buy"
            >
              <p className="font-medium">Before you buy</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {beforeYouBuy(data.terms).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <MoreInfo label="How funding works" testId="funding-how">
            Holders vote funding terms first: whether buyers get non-voting
            shares (no vote) or Shares, a funding limit, an exit fee of at most
            5%, and the one rounds contract that may sell. Nothing sells until
            30 days later, and leaving costs no fee until then, so anyone who
            disagrees can leave whole. After that the fee's part of what leaving
            pays stays in the treasury, for those who stay. Each sale is then
            its own vote, with a quantity, a least price and an end date, and is
            sold in weekly funding rounds: bids set the price, never below a
            share's part of the treasury plus 2%, and nothing sells while the
            treasury holds ETH or a token on its watch list, which any holder
            can add to. Settling a round creates the shares sold and pays the
            treasury at once.
          </MoreInfo>
          {data.phase === "selling" && !data.roundsOn ? (
            <p
              className="mt-2 text-sm text-muted-foreground"
              data-testid="funding-needs-rounds"
            >
              Sales happen in weekly rounds, which this project hasn&apos;t
              switched on yet.
            </p>
          ) : null}
          {canOpen ? (
            <Button
              className="mt-2"
              data-testid="funding-open-round"
              disabled={blocked}
              onClick={() =>
                void sender.send(
                  "funding-open",
                  data.rounds,
                  encodeOpenFundingRound(dao),
                )
              }
              size="sm"
              type="button"
            >
              {sender.busy === "funding-open"
                ? "Opening…"
                : "Open a funding round"}
            </Button>
          ) : null}
          {round &&
          round.phase === "void" &&
          !round.fundingDone &&
          data.roundsOn ? (
            <Button
              className="mt-2"
              data-testid="funding-finish"
              disabled={blocked}
              onClick={() =>
                void sender.send(
                  "funding-finish",
                  data.rounds,
                  encodeFinishFunding(round.id),
                )
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {sender.busy === "funding-finish"
                ? "Giving back…"
                : "Give the unsold shares back to the sale"}
            </Button>
          ) : null}
          {round ? (
            <RoundPanel
              blocked={blocked}
              busy={sender.busy}
              contract={data.rounds}
              currency={data.usdc}
              me={sender.wallet.address}
              onSend={sender.send}
              round={round}
              shares={round.shares}
              side={data.wallet}
            />
          ) : null}
          <RoundClaims
            blocked={blocked}
            busy={sender.busy}
            claims={data.claims}
            contract={data.rounds}
            me={sender.wallet.address}
            onSend={sender.send}
          />
        </>
      )}
      <WalletStrip testIdPrefix="funding" wallet={sender.wallet} />
      {sender.failure ? (
        <FailureNote message={sender.failure} testId="funding-failure" />
      ) : null}
    </Card>
  );
}
