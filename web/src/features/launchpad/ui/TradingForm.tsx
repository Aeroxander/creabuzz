/**
 * "Open trading": the decision that lets Shares be sent between wallets, and so bought and sold (D77).
 *
 * A DAO made by the launch kits is born with trading locked. Opening it is two votes, 30 days apart: one announces it,
 * and the Shares refuse the second until the 30 days have passed, so a holder who does not want a market has that long
 * to leave. The form reads where things stand from the Shares and offers only the step that can run.
 *
 * The rest of the bar for opening a market (CONTRIBUTOR-TOKEN-TRADING.md) is this app's policy: no contract can check
 * that the contracts were audited or that the project had a legal read. The form lists it and asks the person opening
 * the vote to tick that they checked it; nothing on the chain records that tick.
 */

import { useMemo, useState } from "react";

import {
  announceTradingDecision,
  cancelTradingDecision,
  lockTradingDecision,
  openTradingDecision,
  tradingState,
} from "@creaton/core/launchpad/tradingActions.ts";
import { useShareRules } from "../use-share-rules";
import {
  attempt,
  type DraftResult,
  DraftPanel,
  type FormProps,
} from "./decision-forms";

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

/** The bar this app sets before trading opens; the contracts check none of it. */
const BAR = [
  "The project's code has had an outside security review, the market's code included.",
  "The project has had a legal read: Shares that can be sold may be treated as an investment where its holders are.",
  "There is a track record: the Shares are spread across the people who earned or bought them, not held by a few.",
  "The project runs on a main network, not a test network.",
] as const;

export function TradingForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  const read = useShareRules(ctx.sharesToken || null, ctx.dao);
  const [checked, setChecked] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const state = tradingState(read.data?.rules ?? null, ctx.chainTime);
  const sharesToken = ctx.sharesToken;
  const needsBar =
    (state.phase === "locked" || state.phase === "ready") && !withdraw;

  const result = useMemo<DraftResult>(() => {
    const shares = { sharesToken };
    if (state.phase === "open")
      return attempt(() => lockTradingDecision(shares));
    if (state.phase === "announced" || (state.phase === "ready" && withdraw))
      return attempt(() => cancelTradingDecision(shares));
    if (state.phase !== "locked" && state.phase !== "ready")
      return { problem: "Where trading stands has not been read yet." };
    if (!checked)
      return {
        problem: "Tick the box once you have checked each point above.",
      };
    return attempt(() =>
      state.phase === "locked"
        ? announceTradingDecision(shares)
        : openTradingDecision(shares),
    );
  }, [state.phase, checked, withdraw, sharesToken]);

  if (read.isPending) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" role="status">
        Reading where trading stands from the project&apos;s Shares…
      </p>
    );
  }
  if (read.isError) {
    return (
      <p
        className="mt-3 text-sm"
        data-testid="trading-unreadable"
        role="status"
      >
        Couldn&apos;t read the Shares from the network. Try again in a moment.
      </p>
    );
  }
  if (read.data?.predates) {
    return (
      <p className="mt-3 text-sm" data-testid="trading-predates">
        This project&apos;s Shares were made before trading came with a 30-day
        notice, so this app does not offer it here.
      </p>
    );
  }

  return (
    <div className="mt-3 grid gap-3" data-testid="form-trading">
      <p className="text-sm" data-testid="trading-state">
        {state.phase === "open"
          ? "Trading is open: Shares can be sent from one person to another. A vote can lock it again at once."
          : state.phase === "announced" && state.opensAt
            ? `Trading was announced. A second vote can open it from ${when(state.opensAt)}; until then it stays locked.`
            : state.phase === "ready" && state.opensAt
              ? `Trading was announced, and the 30 days passed on ${when(state.opensAt)}. A vote can open it now.`
              : "Trading is locked: Shares cannot be sent to anyone else, so nobody can sell them. Opening it takes two votes: one announces it, and the second can only run 30 days later."}
      </p>
      {state.phase === "ready" ? (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="sr-only">
            Open it, or withdraw the announcement
          </legend>
          <label className="flex items-center gap-2">
            <input
              checked={!withdraw}
              data-testid="trading-choose-open"
              name="trading-step"
              onChange={() => setWithdraw(false)}
              type="radio"
            />
            Open trading now
          </label>
          <label className="flex items-center gap-2">
            <input
              checked={withdraw}
              data-testid="trading-choose-withdraw"
              name="trading-step"
              onChange={() => setWithdraw(true)}
              type="radio"
            />
            Withdraw the announcement instead
          </label>
        </fieldset>
      ) : null}
      {needsBar ? (
        <div
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="trading-bar"
          role="note"
        >
          <p className="font-medium">
            Before trading opens, this app asks for:
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {BAR.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-2">
            The contracts check none of this. A vote can announce trading
            without it; what protects holders is the 30 days, in which anyone
            can leave with their share of the treasury.
          </p>
          <label className="mt-2 flex items-start gap-2">
            <input
              checked={checked}
              className="mt-1"
              data-testid="trading-bar-checked"
              onChange={(event) => setChecked(event.target.checked)}
              type="checkbox"
            />
            I've checked each point above.
          </label>
        </div>
      ) : null}
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty={checked || !needsBar}
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}
