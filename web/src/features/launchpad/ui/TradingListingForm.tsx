/**
 * "Publish a secondary-market listing": the vote that opens the DAO's market at a price grid, or stops new rounds.
 *
 * `SecondaryMarket.configureListing` is the DAO's own call (`contracts/src/SecondaryMarket.sol`), so a listing is a
 * decision and not a button. The form reads the DAO's market from the factory this build knows, so nobody types an
 * address, and says where the market stands before asking what to change.
 */

import { useMemo, useState } from "react";

import { formatUnits, parseUnits } from "@creaton/core/launchpad/daoActions.ts";
import {
  listingPrice,
  secondaryListingDecision,
} from "@creaton/core/launchpad/secondaryListing.ts";
import { SelectField, TextField } from "./decision-fields";
import {
  attempt,
  type DraftResult,
  DraftPanel,
  type FormProps,
} from "./decision-forms";
import { useSecondary } from "../use-secondary";

export function TradingListingForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  // The DAO's own market, read once for the whole page: the factory this build knows names it, so nobody types an
  // address here.
  const { factory, query } = useSecondary({
    chainId: ctx.chainId ?? null,
    dao: ctx.dao,
    wallet: ctx.wallet,
  });

  const [enabled, setEnabled] = useState<"on" | "off">("on");
  const [minText, setMinText] = useState("");
  const [maxText, setMaxText] = useState("");
  const [levelsText, setLevelsText] = useState("");

  const view = query.data ?? null;
  const read = view?.read ?? null;
  const present = read?.kind === "present" ? read : null;
  const listing = present?.listing ?? null;
  const lotSize = view?.facts?.lotSize ?? null;
  const decimals = ctx.currencyDecimals;
  const dirty =
    minText !== "" || maxText !== "" || levelsText !== "" || enabled === "off";
  /** A price as this form writes it, in the sale currency when its decimals are known. */
  const money = (value: bigint) =>
    decimals === null
      ? `${value.toString()} base units`
      : `${listingPrice(value, decimals)} ${ctx.currencySymbol}`;
  const lot =
    lotSize !== null
      ? `one lot of ${formatUnits(lotSize, 18)} Shares`
      : "one whole lot of Shares";

  const result = useMemo<DraftResult>(() => {
    if (factory === null) {
      return {
        problem: "This build knows no secondary market on this network.",
      };
    }
    if (!read) {
      return {
        problem: query.isError
          ? "The market could not be read. Reload to try again."
          : "Reading the market…",
      };
    }
    if (read.kind === "absent") {
      return {
        problem:
          "This project has no secondary market to publish a listing in.",
      };
    }
    if (read.kind === "unreadable") {
      return {
        problem: `The market could not be read (${read.reason}). Reload to try again.`,
      };
    }
    if (decimals === null) {
      return {
        problem: "This project has no sale currency to price a market in.",
      };
    }
    const market = read.market;
    if (enabled === "off") {
      // Disabling carries no terms: the contract writes zeros and ignores whatever is sent.
      return attempt(() =>
        secondaryListingDecision({
          market,
          enabled: false,
          minPrice: 0n,
          maxPrice: 0n,
          levels: 0,
          quoteDecimals: decimals,
          quoteSymbol: ctx.currencySymbol,
        }),
      );
    }
    return attempt(() =>
      secondaryListingDecision({
        market,
        enabled: true,
        minPrice: parseUnits(minText, decimals, "minPrice", "The lowest price"),
        maxPrice: parseUnits(
          maxText,
          decimals,
          "maxPrice",
          "The highest price",
        ),
        levels: levelsText.trim() === "" ? 0 : Number(levelsText),
        quoteDecimals: decimals,
        quoteSymbol: ctx.currencySymbol,
        lotSize: lotSize ?? undefined,
      }),
    );
  }, [
    factory,
    read,
    lotSize,
    query.isError,
    decimals,
    enabled,
    minText,
    maxText,
    levelsText,
    ctx.currencySymbol,
  ]);

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
      <p className="text-sm" data-testid="listing-market-state">
        {!read
          ? query.isError
            ? "Couldn't read this project's market from the network. Reload to try again."
            : "Reading the market…"
          : read.kind === "unreadable"
            ? `Couldn't read this project's market from the network (${read.reason}). Reload to try again.`
            : read.kind === "absent"
              ? "This project has no secondary market, so there is no listing to publish."
              : listing?.enabled
                ? `The market is open: prices from ${money(listing.minPrice)} to ${money(listing.maxPrice)}, in ${listing.levels} steps.`
                : "The market is off: no round can open until a listing is published."}
      </p>
      {present ? (
        <SelectField
          hint="Turning it off stops new rounds. Rounds already open or settled still settle, refund and pay out, and every claim still works."
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
      {present && enabled === "on" ? (
        <>
          <TextField
            hint={`Each price is for ${lot}. Nothing sells below the lowest price or above the highest.`}
            inputMode="decimal"
            label={`Lowest price per lot (${ctx.currencySymbol})`}
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
            label={`Highest price per lot (${ctx.currencySymbol})`}
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
