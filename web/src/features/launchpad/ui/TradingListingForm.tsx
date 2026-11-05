/**
 * "Publish a secondary-market listing": the vote that opens the DAO's market at a price grid, or stops new rounds.
 *
 * `SecondaryMarket.configureListing` is the DAO's own call (`contracts/src/SecondaryMarket.sol`), so a listing is a
 * decision and not a button. The form reads the DAO's market from the factory this build knows, so nobody types an
 * address, and says where the market stands before asking what to change.
 */

import { useMemo, useState } from "react";

import { listingPrice } from "@creaton/core/launchpad/secondaryListing.ts";
import { SelectField, TextField } from "./decision-fields";
import { type DraftResult, DraftPanel, type FormProps } from "./decision-forms";
import { listingFormDraft } from "../lib/listing-draft";
import {
  LISTING_OFF_HINT,
  sharesPhrase,
  unreviewedLine,
} from "../lib/trading-copy";
import { useSecondary } from "../use-secondary";
import { QuoteTokenNote } from "./QuoteTokenNote";

export function TradingListingForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  // The DAO's own market, read once for the whole page: the factory this build knows names it, so nobody types an
  // address here. Read without the wallet: the listing, the terms and the off switch are the DAO's, and a wallet's
  // balances or earlier rounds failing to read must not take the switch away (Review-Proven Rule 6).
  const { factory, query } = useSecondary({
    chainId: ctx.chainId ?? null,
    dao: ctx.dao,
    wallet: null,
  });

  const [enabled, setEnabled] = useState<"on" | "off">("on");
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");
  const [levelsText, setLevelsText] = useState("");

  // Said until the release decision records an outside review (`MARKET_REVIEWED`); a DAO voting on prices should know.
  const unreviewed = unreviewedLine();
  const view = query.data ?? null;
  const read = view?.read ?? null;
  const present = read?.kind === "present" ? read : null;
  const listing = present?.listing ?? null;
  const lotSize = view?.facts?.lotSize ?? null;
  // The market's own quote token, not the launch record's sale currency: a DAO whose record
  // names a different token than the market's quote would otherwise publish a listing priced
  // off by that token's scale — the same defect class as a hardcoded 6 decimals.
  const decimals = view?.facts?.quoteKnown ? view.facts.quoteDecimals : null;
  const symbol = view?.facts?.quoteKnown ? view.facts.quoteSymbol : null;
  const dirty =
    minText !== "" || maxText !== "" || levelsText !== "" || enabled === "off";
  /** A price as this form writes it, in the sale currency when its decimals are known. */
  const money = (value: bigint) =>
    decimals === null || symbol === null
      ? `${value.toString()} base units`
      : `${listingPrice(value, decimals)} ${symbol ?? ""}`.trim();
  const lot =
    lotSize !== null
      ? `one lot of ${sharesPhrase(lotSize)}`
      : "one whole lot of Shares";

  const market = view?.market ?? null;
  const result = useMemo<DraftResult>(
    () =>
      listingFormDraft({
        factoryKnown: factory !== null,
        failed: query.isError,
        read,
        market,
        quote:
          decimals !== null && symbol !== null ? { decimals, symbol } : null,
        lotSize,
        quoteToken: view?.facts?.quoteKnown ? view.facts.quoteToken : null,
        saleCurrency: ctx.saleCurrency,
        enabled,
        minText,
        maxText,
        levelsText,
      }),
    [
      factory,
      query.isError,
      read,
      market,
      decimals,
      symbol,
      lotSize,
      view?.facts?.quoteKnown,
      view?.facts?.quoteToken,
      ctx.saleCurrency,
      enabled,
      minText,
      maxText,
      levelsText,
    ],
  );

  if (factory !== null && query.isPending) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" role="status">
        Reading the market…
      </p>
    );
  }
  return (
    <div className="mt-3 grid gap-3" data-testid="form-secondary-listing">
      <p className="text-sm text-muted-foreground">
        Publish the DAO&apos;s listing in its secondary market, or stop new
        rounds. Publishing it is a vote: nothing opens until holders back it and
        it takes effect.
      </p>
      {unreviewed ? (
        <p
          className="rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="listing-unreviewed"
          role="note"
        >
          {unreviewed}
        </p>
      ) : null}
      <p className="text-sm" data-testid="listing-market-state">
        {!read
          ? query.isError
            ? "Couldn't read this project's market from the network. Reload to try again."
            : "Reading the market…"
          : read.kind === "unreadable"
            ? "Couldn't read this project's market from the network. Reload to try again."
            : read.kind === "absent"
              ? "This project has no secondary market, so there is no listing to publish."
              : listing?.enabled
                ? `The market is open: prices from ${money(listing.minPrice)} to ${money(listing.maxPrice)}, in ${listing.levels} steps.`
                : "The market is off: no round can open until a listing is published."}
      </p>
      {present && view?.facts?.quoteKnown ? (
        <QuoteTokenNote
          address={view.facts.quoteToken}
          saleCurrency={ctx.saleCurrency}
          symbol={view.facts.quoteSymbol}
        />
      ) : null}
      {market !== null && view?.tokenUnreadable ? (
        <p className="text-sm text-muted-foreground" role="status">
          The market&apos;s price token isn&apos;t answering, so prices
          can&apos;t be set right now. You can still stop new rounds.
        </p>
      ) : null}
      {market !== null ? (
        <SelectField
          hint={LISTING_OFF_HINT}
          label="The listing"
          onChange={(value) => setEnabled(value === "off" ? "off" : "on")}
          options={[
            { value: "on", label: "Publish prices and steps (or change them)" },
            { value: "off", label: "Stop new trading rounds" },
          ]}
          testId="listing-enabled-input"
          value={enabled}
        />
      ) : null}
      {present && !view?.tokenUnreadable && enabled === "on" ? (
        <>
          <TextField
            hint={`Each price is for ${lot}. Nothing sells below the lowest price or above the highest.`}
            inputMode="decimal"
            label={`Lowest price per lot (${symbol ?? "base units"})`}
            onChange={setMinText}
            placeholder={
              listing?.enabled && decimals !== null
                ? listingPrice(listing.minPrice, decimals)
                : "1.60"
            }
            testId="listing-min-input"
            value={minText}
          />
          <TextField
            hint="The grid runs from the lowest price to the highest, and a round's price is one level on it. Nothing sells outside the two, however much is bid."
            inputMode="decimal"
            label={`Highest price per lot (${symbol ?? "base units"})`}
            onChange={setMaxText}
            placeholder={
              listing?.enabled && decimals !== null
                ? listingPrice(listing.maxPrice, decimals)
                : "8.00"
            }
            testId="listing-max-input"
            value={maxText}
          />
          <TextField
            hint="How many steps the range is cut into, 1 to 64. The market refuses a range its steps do not divide evenly, so every level is a whole price."
            inputMode="numeric"
            label="Price steps"
            onChange={setLevelsText}
            placeholder={listing?.enabled ? String(listing.levels) : "64"}
            testId="listing-levels-input"
            value={levelsText}
          />
        </>
      ) : null}
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty={dirty}
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}
