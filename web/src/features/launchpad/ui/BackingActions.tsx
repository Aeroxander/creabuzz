/**
 * The actions of a project's Backing block, by where backing stands: open it (the founder), bid in the opening round,
 * back it, sell, leave at a milestone, settle a milestone or a round (anyone), exchange round tokens for units, and post a
 * milestone (the founder). It sends through the same account the Trading card does (`useChainSend`: a passkey account
 * with covered fees, or the browser's wallet), one batch per step, and says why a button is off before anyone presses it.
 */

import {
  type NoPoolView,
  nextMilestone,
  type PoolView,
} from "@creaton/core/launchpad/backing.ts";
import { useId, useState } from "react";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { settleMilestoneCalls } from "../lib/backing-orders";
import type { BackingTarget } from "../lib/backing-target";
import { placeOrder } from "../lib/trading-orders";
import type { Launch } from "../models";
import type { useChainSend } from "../use-chain-send";
import { GateNote, StatusLine } from "./account-widgets";
import { BackForm, LeavePanel, SellForm } from "./BackingTrade";
import {
  isFounderAccount,
  OpenBacking,
  PostMilestone,
  WaitLine,
} from "./BackingFounder";
import {
  BidsDisclosure,
  FailedRound,
  RedeemRow,
  RoundCard,
} from "./BackingRound";
import { TestTokenMint } from "./TestTokenMint";
import { isTestQuote } from "../lib/test-token";
import {
  FOUNDER_ACCOUNT_LINE,
  TEST_TOKEN_BACKING_NOTE,
} from "../lib/backing-copy";

type Sender = ReturnType<typeof useChainSend>;

export function BackingActions({
  launch,
  view,
  target,
  sender,
  isFounder,
}: {
  launch: Launch;
  view: PoolView | NoPoolView;
  target: BackingTarget;
  sender: Sender;
  isFounder: boolean;
}) {
  const gateId = useId();
  const [form, setForm] = useState<"back" | "sell" | "leave" | null>(null);
  const [done, setDone] = useState("");
  if (target.kind !== "target") return null;
  const me = sender.wallet.address;
  const signedIn = existingUserPubkey() !== null;
  const blocked = sender.busy !== null || sender.gate !== null;
  const gateNoteId = sender.gate !== null && me ? gateId : undefined;
  const place = (key: string, build: Parameters<typeof placeOrder>[1]) =>
    placeOrder(key, build, sender.sendBatch, sender.reportFailure);
  const gate = (
    <GateNote
      gate={
        gateNoteId === undefined || sender.gate === null
          ? { ok: true }
          : { ok: false, message: sender.gate }
      }
      id={gateNoteId}
      testId="backing-gate"
    />
  );
  const status = <StatusLine testId="backing-done" text={done} />;

  if (view.kind === "none") {
    // Only the founder has anything to do before a pool exists.
    if (!isFounder) return null;
    return (
      <div className="flex flex-col gap-2">
        {gate}
        <OpenBacking
          blocked={blocked}
          busy={sender.busy}
          gateNoteId={gateNoteId}
          me={me}
          place={place}
          target={{ factory: target.factory, dao: target.dao }}
          view={view}
        />
        {status}
      </div>
    );
  }

  const { snapshot } = view;
  const next = nextMilestone(snapshot, view.now);
  const founderHere = isFounder && isFounderAccount(me, view.founder, view.dao);
  const common = { blocked, busy: sender.busy, gateNoteId, place };
  const finish = (words: string) => {
    setForm(null);
    setDone(words);
  };
  const testToken = isTestQuote(view.quote.address, launch.record.chainId);

  const money = (
    <>
      {testToken ? (
        <TestTokenMint
          blocked={blocked}
          busy={sender.busy}
          chainId={launch.record.chainId}
          gateNoteId={gateNoteId}
          me={me}
          note={TEST_TOKEN_BACKING_NOTE}
          onSend={sender.send}
          quote={{
            quoteToken: view.quote.address,
            quoteDecimals: view.quote.decimals,
          }}
        />
      ) : null}
    </>
  );

  // A failed round: the founder may open again; bidders take their money back.
  if (view.phase === "failed") {
    return (
      <div className="flex flex-col gap-3">
        {gate}
        <FailedRound {...common} launch={launch} me={me} view={view} />
        {isFounder ? (
          <OpenBacking
            blocked={blocked}
            busy={sender.busy}
            gateNoteId={gateNoteId}
            me={me}
            place={place}
            target={{ factory: target.factory, dao: target.dao }}
            view={view}
          />
        ) : null}
        {status}
      </div>
    );
  }

  if (view.phase === "waiting") {
    return (
      <div className="flex flex-col gap-3">
        {gate}
        {money}
        <RoundCard
          {...common}
          launch={launch}
          me={signedIn ? me : null}
          view={view}
        />
        {!signedIn ? <SignIn /> : null}
        {status}
      </div>
    );
  }

  const canSell = snapshot.holderUnits > 0n;
  const abandoned = view.phase === "abandoned";
  const windowRunning = next.kind === "window";
  const mayLeave = windowRunning && snapshot.holderCanLeave;
  const releasable = next.kind === "release" || next.kind === "cancel";

  return (
    <div className="flex flex-col gap-3">
      {gate}
      <div className="flex flex-wrap gap-2">
        {!abandoned && me ? (
          <Button
            aria-controls="backing-form"
            aria-expanded={form === "back"}
            className="max-sm:h-11"
            data-testid="backing-back"
            onClick={() => setForm(form === "back" ? null : "back")}
            size="sm"
            type="button"
          >
            Back this project
          </Button>
        ) : null}
        {canSell && me ? (
          <Button
            aria-controls="backing-form"
            aria-expanded={form === "sell"}
            className="max-sm:h-11"
            data-testid="backing-sell"
            onClick={() => setForm(form === "sell" ? null : "sell")}
            size="sm"
            type="button"
            variant="outline"
          >
            {abandoned ? "Sell and take my held money back" : "Sell"}
          </Button>
        ) : null}
        {mayLeave && me ? (
          <Button
            aria-controls="backing-form"
            aria-expanded={form === "leave"}
            className="max-sm:h-11"
            data-testid="backing-leave"
            onClick={() => setForm(form === "leave" ? null : "leave")}
            size="sm"
            type="button"
            variant="outline"
          >
            Leave at this milestone
          </Button>
        ) : null}
        {releasable ? (
          <Button
            aria-describedby={gateNoteId}
            className="max-sm:h-11"
            data-testid="backing-settle"
            disabled={blocked || !me}
            onClick={async () => {
              const landed = await place("backing-settle", () =>
                settleMilestoneCalls(view.pool),
              );
              if (landed)
                setDone(
                  next.kind === "release"
                    ? "The milestone was settled."
                    : "The milestone was closed. Nothing was released.",
                );
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {sender.busy === "backing-settle"
              ? "Settling…"
              : next.kind === "release"
                ? "Settle the milestone"
                : "Close the milestone"}
          </Button>
        ) : null}
        {!signedIn ? <SignIn /> : null}
      </div>
      {money}
      <div id="backing-form">
        {form === "back" && me ? (
          <BackForm
            {...common}
            onCancel={() => setForm(null)}
            onDone={() => finish("Done. Your backing is in.")}
            view={view}
          />
        ) : null}
        {form === "sell" && me ? (
          <SellForm
            {...common}
            onCancel={() => setForm(null)}
            onDone={() => finish("Done. Your units were sold.")}
            view={view}
          />
        ) : null}
        {form === "leave" && me && mayLeave ? (
          <LeavePanel
            {...common}
            onCancel={() => setForm(null)}
            onDone={() => finish("You left. Your held money is back with you.")}
            view={view}
          />
        ) : null}
      </div>
      <RedeemRow {...common} view={view} />
      {view.snapshot.round.state === "live" && me ? (
        <BidsDisclosure {...common} launch={launch} me={me} view={view} />
      ) : null}
      {isFounder && !abandoned ? (
        founderHere ? (
          next.kind === "ready" ? (
            <PostMilestone launch={launch} view={view} {...common} />
          ) : next.kind === "wait" ? (
            <WaitLine from={next.from} />
          ) : null
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="backing-founder-account"
          >
            {FOUNDER_ACCOUNT_LINE}
          </p>
        )
      ) : null}
      {status}
    </div>
  );
}

function SignIn() {
  return (
    <Button
      className="max-sm:h-11"
      data-testid="backing-sign-in"
      onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
      size="sm"
      type="button"
    >
      Sign in to back this project
    </Button>
  );
}
