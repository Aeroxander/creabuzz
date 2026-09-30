import * as React from "react";

import type { Launch, LaunchBid } from "@/features/launchpad/launchpadModels";
import { ContinueOnWebButton } from "@/features/launchpad/ui/ContinueOnWebButton";
import { useIdentityQuery } from "@/shared/api/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";

function formatAmount(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

function BidRow({ bid }: { bid: LaunchBid }) {
  const budget = formatAmount(bid.budget);
  const maxPrice = formatAmount(bid.maxPrice);
  return (
    <li className="min-h-20 rounded-xl border border-border/70 bg-card/60 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              Bid · {bid.bucket || "default bucket"}
            </span>
            {bid.tx ? (
              <span className="rounded-full border border-border/70 px-2 py-0.5 font-mono text-2xs text-muted-foreground">
                {truncatePubkey(bid.tx)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-2xs text-muted-foreground">
            {budget !== null ? `Budget ${budget}` : "Budget not mirrored"}
            {maxPrice !== null ? ` · max price ${maxPrice}` : ""} · mirrored{" "}
            {new Date(bid.createdAt * 1000).toLocaleDateString()}
          </p>
        </div>
      </div>
    </li>
  );
}

/**
 * "My bids" — READ-ONLY status over the mirrored bid feed, plus the web
 * handoff for the money actions. The desktop app does not send exits or
 * claims: the web app owns the money plane (passkey-first custody), and
 * `ContinueOnWebButton` deep-links into web's canonical launch detail
 * (`?action=exit` / `?action=claim`). Rows show the current account's
 * mirrored bids (kind-47002 feed) — the chain remains the ledger.
 */
export function MyBidsPanel({
  launch,
  relayOrigin,
}: {
  launch: Launch;
  relayOrigin: string | null;
}) {
  const identity = useIdentityQuery();
  const pubkey = identity.data?.pubkey;
  const myBids = React.useMemo(
    () =>
      pubkey === undefined
        ? []
        : launch.bids.filter((bid) => bid.author === pubkey),
    [launch.bids, pubkey],
  );
  const { record } = launch;

  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">My bids</h3>
        <p className="mt-1 text-2xs text-muted-foreground">
          Read-only bid status for this launch. Exit, refund, and claim happen
          on the web app — same account, sponsored.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {record.auction
            ? `Auction deployed at ${truncatePubkey(record.auction)}.`
            : "Auction not deployed yet."}{" "}
          Mirrored bids on this launch: {launch.bids.length} ({myBids.length}{" "}
          from this account).
        </p>
      </section>

      {myBids.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No bids mirrored from this account on this launch yet.
        </p>
      ) : (
        <ul aria-label="Your mirrored bids" className="flex flex-col gap-2">
          {myBids.map((bid) => (
            <BidRow bid={bid} key={bid.id} />
          ))}
        </ul>
      )}

      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Exit &amp; claim on the web</h3>
        <p className="mt-1 text-2xs text-muted-foreground">
          Exit refunds the unfilled budget and records the filled share; claim
          transfers the filled tokens after the claim block. Both run in the web
          app with your passkey — this cockpit only shows status.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <ContinueOnWebButton
            action="exit"
            label="Exit or refund on web"
            launch={{ id: record.id, author: record.author }}
            relayOrigin={relayOrigin}
            testid="continue-on-web-exit"
            variant="outline"
          />
          <ContinueOnWebButton
            action="claim"
            label="Claim on web"
            launch={{ id: record.id, author: record.author }}
            relayOrigin={relayOrigin}
            testid="continue-on-web-claim"
          />
        </div>
      </section>
    </div>
  );
}
