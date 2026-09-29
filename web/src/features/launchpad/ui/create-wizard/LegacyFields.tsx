/**
 * The original create form, field for field — the "everything else" behind the
 * wizard's Advanced drawer, and the whole body of the edit dialog.
 *
 * A function returning JSX rather than a component: called from
 * `CreateLaunchDialog` it keeps element identity across renders (a component
 * defined inside another would be a new type on every render and React would
 * remount it, losing focus on every keystroke), and it keeps the dialog file
 * under the repository's file-size gate without splitting one form's state
 * across two owners.
 *
 * `showWizardOwned` decides the fields the wizard steps render themselves
 * (name, symbol, total supply): hidden here in create mode so no control ever
 * has two owners — one label, one input, one owner (Review-Proven Rule 7).
 * The raw price, threshold, budget and block window stay in both modes; they
 * carry different labels from the wizard's plain-language versions and are the
 * override path the advanced-passthrough test pins.
 */

import type { ReactNode } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  LAUNCH_DEFAULTS,
  isEvmAddress,
  suggestSymbol,
  type VestingConfig,
} from "../../models";
import type { CreateLaunchInput } from "../../use-launches";
import {
  ALLOCATION_LABELS,
  minimumLiquidityPercent,
  type SupplyAllocation,
} from "../../lib/allocation";
import type { SaleCurrency } from "../../lib/sale-currency";
import type { VestingIssue } from "../../lib/vesting-params";
import { effectiveLaunchId } from "../../lib/wizard";
import { Field } from "./fields";

/** The relay caps `buzz-channel` tags on a launch record. */
const MAX_BOUND_CHANNELS = 8;

/** Raw block overrides as `parseRawBlocks` reports them. */
export type RawBlockFields =
  | { startBlock: number; endBlock: number; claimBlock: number }
  | null
  | "incomplete";

/** Everything the legacy body reads or changes — assembled by the dialog. */
export interface LegacyFieldsState {
  id: string;
  setId(value: string): void;
  onName(value: string): void;
  name: string;
  pitch: string;
  setPitch(value: string): void;
  initial: Partial<CreateLaunchInput> | undefined;
  longPitch: string;
  setLongPitch(value: string): void;
  ipList: string;
  setIpList(value: string): void;
  updateCadence: string;
  setUpdateCadence(value: string): void;
  tokenMode: "mint" | "import";
  setTokenMode(value: "mint" | "import"): void;
  tokenName: string;
  setTokenName(value: string): void;
  symbol: string;
  setSymbol(value: string): void;
  totalSupplyText: string;
  onTotalSupply(value: string): void;
  importAddress: string;
  setImportAddress(value: string): void;
  verifyState: "idle" | "checking" | "ok" | "missing" | "error";
  setVerifyState(value: "idle" | "checking" | "ok" | "missing" | "error"): void;
  verifyImport(): void;
  chainId: string;
  setChainId(value: string): void;
  admission: "curated" | "community";
  setAdmission(value: "curated" | "community"): void;
  currency: string;
  setCurrency(value: string): void;
  /** What `currency` means: symbol and decimals. */
  saleCurrency: SaleCurrency;
  allocation: SupplyAllocation;
  /** One allocation input changed — the dialog re-derives the tranche too. */
  setAllocationValue(key: keyof SupplyAllocation, value: number): void;
  /** "Standard split" — the dialog resets to the standard allocation. */
  resetAllocation(): void;
  allocationMessage: string | null;
  vesting: VestingConfig | null;
  setVesting(
    updater: (previous: VestingConfig | null) => VestingConfig | null,
  ): void;
  markVestingDirty(): void;
  vestingIssues: VestingIssue[];
  floorPrice: string;
  /** The raw Q96 floor was edited — the dialog mirrors it into the wizard. */
  onFloorChange(value: string): void;
  requiredRaised: string;
  setRequiredRaised(value: string): void;
  tickSpacing: string;
  setTickSpacing(value: string): void;
  startBlockRaw: string;
  setStartBlockRaw(value: string): void;
  endBlockRaw: string;
  setEndBlockRaw(value: string): void;
  claimBlockRaw: string;
  setClaimBlockRaw(value: string): void;
  rawBlocks: RawBlockFields;
  budget: string;
  setBudget(value: string): void;
  auction: string;
  setAuction(value: string): void;
  treasury: string;
  setTreasury(value: string): void;
  channelList: { id: string; name: string }[] | undefined;
  boundChannels: string[];
  setBoundChannels(updater: (previous: string[]) => string[]): void;
  asAgent: boolean;
  setAsAgent(value: boolean): void;
}

export function legacyFields(
  fields: LegacyFieldsState,
  showWizardOwned: boolean,
): ReactNode {
  const {
    id,
    setId,
    onName,
    name,
    pitch,
    setPitch,
    initial,
    longPitch,
    setLongPitch,
    ipList,
    setIpList,
    updateCadence,
    setUpdateCadence,
    tokenMode,
    setTokenMode,
    tokenName,
    setTokenName,
    symbol,
    setSymbol,
    totalSupplyText,
    onTotalSupply,
    importAddress,
    setImportAddress,
    verifyState,
    setVerifyState,
    verifyImport,
    chainId,
    setChainId,
    admission,
    setAdmission,
    saleCurrency,
    allocation,
    setAllocationValue,
    resetAllocation,
    allocationMessage,
    vesting,
    setVesting,
    markVestingDirty,
    vestingIssues,
    floorPrice,
    onFloorChange,
    requiredRaised,
    setRequiredRaised,
    tickSpacing,
    setTickSpacing,
    startBlockRaw,
    setStartBlockRaw,
    endBlockRaw,
    setEndBlockRaw,
    claimBlockRaw,
    setClaimBlockRaw,
    rawBlocks,
    budget,
    setBudget,
    auction,
    setAuction,
    treasury,
    setTreasury,
    channelList,
    boundChannels,
    setBoundChannels,
    asAgent,
    setAsAgent,
  } = fields;
  return (
    <>
      <Field
        id="launch-id"
        label="Launch id"
        hint="Lowercase slug. Permanent — it addresses the launch on the relay. Left empty, it is derived from the name."
      >
        <Input
          id="launch-id"
          onChange={(e) => setId(e.target.value)}
          placeholder={slugPlaceholder(name)}
          value={id}
        />
      </Field>
      {showWizardOwned ? (
        <Field id="launch-name" label="Name">
          <Input
            id="launch-name"
            onChange={(e) => onName(e.target.value)}
            placeholder="Nebula DAO"
            value={name}
          />
        </Field>
      ) : null}
      <Field id="launch-pitch" label="Pitch">
        <textarea
          id="launch-pitch"
          className="w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white"
          onChange={(e) => setPitch(e.target.value)}
          placeholder="What problem gets solved, and why now?"
          rows={3}
          value={pitch}
        />
      </Field>
      <details
        className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
        data-testid="launch-advanced-founder"
        {...(initial ? { open: true } : {})}
      >
        <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
          Founder commitments
          <span className="ml-2 text-xs font-normal text-black/50 dark:text-white/50">
            required before the launch goes live
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field
            id="launch-long-pitch"
            label="The longer story"
            hint="What exists today, why now, and what failure looks like. The record only goes live once this is committed."
          >
            <textarea
              id="launch-long-pitch"
              data-testid="launch-long-pitch"
              className="w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white"
              onChange={(e) => setLongPitch(e.target.value)}
              placeholder="What is already built, who is on the team, what you will build next — and what would show the thesis is wrong."
              rows={4}
              value={longPitch}
            />
          </Field>
          <Field
            id="launch-ip-list"
            label="Committed assets"
            hint="One link per line — repos, docs, social accounts, domains."
          >
            <textarea
              id="launch-ip-list"
              data-testid="launch-ip-list"
              className="w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white"
              onChange={(e) => setIpList(e.target.value)}
              placeholder={"https://github.com/…\nhttps://docs.example.com/…"}
              rows={3}
              value={ipList}
            />
          </Field>
          <Field
            id="launch-update-cadence"
            label="Update cadence"
            hint='What you commit to telling investors, e.g. "monthly with KPIs".'
          >
            <Input
              id="launch-update-cadence"
              data-testid="launch-update-cadence"
              onChange={(e) => setUpdateCadence(e.target.value)}
              placeholder="monthly with KPIs"
              value={updateCadence}
            />
          </Field>
        </div>
      </details>

      <div className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Token</span>
          <div className="flex gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/10">
            {(["mint", "import"] as const).map((mode) => (
              <button
                key={mode}
                aria-pressed={tokenMode === mode}
                onClick={() => setTokenMode(mode)}
                className={`rounded-md px-2 py-1 text-sm capitalize ${
                  tokenMode === mode
                    ? "bg-white shadow-sm dark:bg-black"
                    : "text-black/60 dark:text-white/60"
                }`}
                type="button"
              >
                {mode === "mint" ? "Mint new" : "Import"}
              </button>
            ))}
          </div>
        </div>
        {tokenMode === "mint" ? (
          <div className="mt-2 flex flex-col gap-3">
            <p className="text-xs text-black/60 dark:text-white/60">
              No addresses needed. Minting deploys a reserve-backed apptoken and
              is a separate step after publishing.
            </p>
            <div className="flex flex-col gap-3">
              <Field id="launch-token-name" label="Token name">
                <Input
                  id="launch-token-name"
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="Nebula Token"
                  value={tokenName}
                />
              </Field>
              {showWizardOwned ? (
                <Field id="launch-symbol" label="Symbol">
                  <Input
                    id="launch-symbol"
                    onChange={(e) => setSymbol(e.target.value)}
                    placeholder={suggestSymbol(name) || "NEB"}
                    value={symbol}
                  />
                </Field>
              ) : null}
            </div>
            {showWizardOwned ? (
              <Field
                id="launch-supply"
                label="Total supply"
                hint="Whole tokens, 18 decimals onchain. The part your allocation marks as sold is what the sale offers."
              >
                <Input
                  id="launch-supply"
                  inputMode="numeric"
                  onChange={(e) => onTotalSupply(e.target.value)}
                  placeholder={LAUNCH_DEFAULTS.supply}
                  value={totalSupplyText}
                />
              </Field>
            ) : (
              <p className="text-xs text-black/60 dark:text-white/60">
                Name, symbol and total supply are on the first step.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-2">
            <Field
              id="launch-import"
              label="Token contract"
              hint="Already launched elsewhere? Paste its address."
            >
              <span className="flex gap-1">
                <Input
                  id="launch-import"
                  onChange={(e) => {
                    setImportAddress(e.target.value);
                    setVerifyState("idle");
                  }}
                  placeholder="0x…"
                  value={importAddress}
                />
                <Button
                  disabled={
                    !isEvmAddress(importAddress) || verifyState === "checking"
                  }
                  onClick={() => void verifyImport()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {verifyState === "checking" ? "…" : "Verify"}
                </Button>
              </span>
            </Field>
            {verifyState === "ok" ? (
              <p className="mt-1 text-xs text-emerald-600">
                Contract found onchain.
              </p>
            ) : null}
            {verifyState === "missing" ? (
              <p className="mt-1 text-xs text-amber-600">
                No contract at this address on the configured RPC.
              </p>
            ) : null}
            {verifyState === "error" ? (
              <p className="mt-1 text-xs text-amber-600">
                Couldn&apos;t reach the chain. Format looks right; you can still
                publish.
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <Field id="launch-chain" label="Chain id" hint="11155111 = Sepolia.">
          <Input
            id="launch-chain"
            onChange={(e) => setChainId(e.target.value)}
            placeholder="11155111"
            value={chainId}
          />
        </Field>
        <Field id="launch-admission" label="Admission track">
          <div className="flex gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/10">
            {(["curated", "community"] as const).map((track) => (
              <button
                key={track}
                aria-pressed={admission === track}
                onClick={() => setAdmission(track)}
                className={`flex-1 rounded-md px-2 py-1 text-sm capitalize ${
                  admission === track
                    ? "bg-white shadow-sm dark:bg-black"
                    : "text-black/60 dark:text-white/60"
                }`}
                type="button"
              >
                {track}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <div className="flex flex-col gap-3">
        <p
          className="text-sm text-black/60 dark:text-white/60"
          data-testid="launch-currency"
        >
          Raised in{" "}
          <span className="font-medium text-black dark:text-white">
            {saleCurrency.kind === "custom"
              ? `token ${saleCurrency.value}`
              : saleCurrency.symbol}
          </span>
          . The choice between ETH and USDC is made on the sale step.
        </p>
        <div
          className="rounded-lg border border-black/10 p-3 dark:border-white/10"
          data-testid="launch-allocation"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Supply allocation</p>
            <Button
              data-testid="launch-allocation-standard"
              onClick={resetAllocation}
              size="sm"
              type="button"
              variant="ghost"
            >
              Standard split
            </Button>
          </div>
          <p className="mt-0.5 text-xs text-black/60 dark:text-white/60">
            The part that is not sold decides what the sold part is worth.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ALLOCATION_LABELS.map(({ key, label, hint }) => (
              <label className="flex flex-col gap-0.5 text-xs" key={key}>
                <span className="font-medium">{label} %</span>
                <input
                  className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm tabular-nums dark:border-white/15"
                  data-testid={`launch-allocation-${key}`}
                  inputMode="numeric"
                  min={0}
                  max={100}
                  onChange={(event) => {
                    const next =
                      Number(event.target.value.replace(/\D/g, "")) || 0;
                    setAllocationValue(key, next);
                  }}
                  type="number"
                  value={allocation[key]}
                />
                <span className="text-black/60 dark:text-white/60">{hint}</span>
              </label>
            ))}
          </div>
          {allocationMessage ? (
            <p
              className="mt-2 text-xs text-red-600 dark:text-red-400"
              data-testid="launch-allocation-issue"
            >
              {allocationMessage}
            </p>
          ) : null}
          {(() => {
            const minLiquidity = minimumLiquidityPercent({
              salePercent: allocation.sale,
              raiseShareBps: 2000,
            });
            if (minLiquidity === null) return null;
            const thin = allocation.liquidity < minLiquidity;
            return (
              <p
                className={`mt-1 text-xs ${
                  thin
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-black/50 dark:text-white/50"
                }`}
                data-testid="launch-lp-minimum"
              >
                {thin
                  ? `This seeds the pool with under ${minLiquidity}% of supply — it covers less than 20% of the floor raise, so day-one liquidity will be thin.`
                  : `A pool at ${allocation.liquidity}% of supply covers ${Math.round(
                      (allocation.liquidity / allocation.sale) * 20,
                    )}% of the floor raise at the floor price.`}
              </p>
            );
          })()}
        </div>

        <details
          className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
          data-testid="launch-advanced-vesting"
          {...(initial ? { open: true } : {})}
        >
          <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
            Performance vesting (optional)
          </summary>
          <div className="mt-3">
            <div
              className="rounded-lg border border-black/10 p-3 dark:border-white/10"
              data-testid="launch-vesting"
            >
              <p className="text-sm font-medium">Performance vesting</p>
              <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                Tranches unlock as the token price reaches multiples of the
                raise price (2x up to 32x by default). This is recorded on the
                launch for now; onchain enforcement comes with verifier
                milestones.
              </p>
              <label
                className="mt-2 block text-sm text-black/60 dark:text-white/60"
                htmlFor="launch-cliff"
              >
                Cliff (blocks)
              </label>
              <Input
                id="launch-cliff"
                data-testid="launch-cliff"
                className="mt-1"
                onChange={(e) => {
                  markVestingDirty();
                  setVesting((prev) =>
                    prev
                      ? { ...prev, cliffBlocks: Number(e.target.value) || 0 }
                      : prev,
                  );
                }}
                type="number"
                value={vesting?.cliffBlocks ?? 0}
              />
              <label
                className="mt-2 block text-sm text-black/60 dark:text-white/60"
                htmlFor="launch-tranches"
              >
                Tranches (multiple:percent, one per line)
              </label>
              <textarea
                id="launch-tranches"
                data-testid="launch-tranches"
                className="mt-1 w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white"
                onChange={(e) => {
                  const parsed: Array<{
                    multiple: number;
                    percent: number;
                  }> = [];
                  for (const line of e.target.value.split("\n")) {
                    const m = line.match(/^(\d+):(\d+)$/);
                    if (m)
                      parsed.push({
                        multiple: Number(m[1]),
                        percent: Number(m[2]),
                      });
                  }
                  if (parsed.length > 0) markVestingDirty();
                  setVesting((prev) =>
                    parsed.length > 0
                      ? {
                          ...(prev ?? {
                            cliffBlocks: 0,
                            tranches: [],
                            twapWindow: null,
                          }),
                          tranches: parsed,
                        }
                      : prev,
                  );
                }}
                placeholder={"2:20\n4:20\n8:20\n16:20\n32:20"}
                rows={4}
                value={
                  vesting?.tranches
                    .map((t) => `${t.multiple}:${t.percent}`)
                    .join("\n") ?? ""
                }
              />
              {vestingIssues.length > 0 ? (
                <p
                  className="mt-2 text-xs text-red-600 dark:text-red-400"
                  data-testid="launch-vesting-issue"
                >
                  {vestingIssues[0].message}
                </p>
              ) : null}
            </div>
          </div>
        </details>
        <Field
          id="launch-floor"
          label="Floor price"
          hint="Smallest currency units. The wizard's price writes this; type here to override it."
        >
          <Input
            id="launch-floor"
            onChange={(e) => onFloorChange(e.target.value)}
            placeholder="1000000"
            value={floorPrice}
          />
        </Field>
        <Field
          id="launch-threshold"
          label="Graduation threshold"
          hint="Minimum proceeds, in currency base units. Miss it and every bid refunds in full."
        >
          <Input
            id="launch-threshold"
            onChange={(e) => setRequiredRaised(e.target.value)}
            placeholder="1000000000"
            value={requiredRaised}
          />
        </Field>
        <Field
          id="launch-window"
          label="Sale window (raw blocks)"
          hint="The wizard derives these from the dates you picked. Override all three, or leave them empty."
        >
          <div className="flex gap-1">
            <Input
              aria-label="Start block"
              data-testid="launch-start-block"
              inputMode="numeric"
              onChange={(e) => setStartBlockRaw(e.target.value)}
              placeholder="start"
              value={startBlockRaw}
            />
            <Input
              aria-label="End block"
              data-testid="launch-end-block"
              inputMode="numeric"
              onChange={(e) => setEndBlockRaw(e.target.value)}
              placeholder="end"
              value={endBlockRaw}
            />
            <Input
              aria-label="Claims open at block"
              data-testid="launch-claim-block"
              inputMode="numeric"
              onChange={(e) => setClaimBlockRaw(e.target.value)}
              placeholder="claims"
              value={claimBlockRaw}
            />
          </div>
          {rawBlocks === "incomplete" ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              Set all three blocks, with claims at or after the end — or clear
              them and let the wizard convert your dates.
            </p>
          ) : null}
        </Field>
      </div>
      <details
        className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
        data-testid="launch-advanced-sale"
        {...(initial ? { open: true } : {})}
      >
        <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
          Sale &amp; treasury details
          <span className="ml-2 text-xs font-normal text-black/50 dark:text-white/50">
            defaults are fine to start
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field
            id="launch-budget"
            label="Monthly budget"
            hint="Operating budget in currency base units; above a sixth of the threshold this warns."
          >
            <Input
              id="launch-budget"
              data-testid="launch-budget"
              onChange={(e) => setBudget(e.target.value)}
              placeholder="0"
              value={budget}
              type="number"
            />
          </Field>
          <Field
            id="launch-tick"
            label="Tick spacing"
            hint="Price granularity."
          >
            <Input
              id="launch-tick"
              onChange={(e) => setTickSpacing(e.target.value)}
              placeholder="100"
              value={tickSpacing}
            />
          </Field>
          <Field
            id="launch-auction"
            label="Auction contract"
            hint="Optional now — link it when the sale deploys."
          >
            <Input
              id="launch-auction"
              onChange={(e) => setAuction(e.target.value)}
              placeholder="0x…"
              value={auction}
            />
          </Field>
          <Field
            id="launch-treasury"
            label="Treasury"
            hint="Receives the minted supply. Optional now."
          >
            <Input
              id="launch-treasury"
              onChange={(e) => setTreasury(e.target.value)}
              placeholder="0x…"
              value={treasury}
            />
          </Field>
        </div>
      </details>
      <fieldset>
        <legend className="text-sm font-medium text-black dark:text-white">
          Discussion channels
        </legend>
        <div
          className="mt-1 flex flex-wrap gap-1.5"
          data-testid="launch-channels"
        >
          {(channelList ?? []).map((channel) => {
            const bound = boundChannels.includes(channel.id);
            const atCap = boundChannels.length >= MAX_BOUND_CHANNELS;
            return (
              <button
                aria-pressed={bound}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                  bound
                    ? "border-black/30 bg-black/10 dark:border-white/30 dark:bg-white/15"
                    : "border-black/15 dark:border-white/15"
                }`}
                data-testid={`launch-channel-${channel.name}`}
                disabled={!bound && atCap}
                key={channel.id}
                onClick={() =>
                  setBoundChannels((prev) =>
                    prev.includes(channel.id)
                      ? prev.filter((id) => id !== channel.id)
                      : [...prev, channel.id],
                  )
                }
                type="button"
              >
                #{channel.name}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          {channelList && channelList.length > 0
            ? `Up to ${MAX_BOUND_CHANNELS}. The launch is listed in the rooms where it is discussed.`
            : "No channels in this community yet."}
        </p>
      </fieldset>
      <label className="flex items-start gap-2 text-sm text-black/60 dark:text-white/60">
        <input
          checked={asAgent}
          data-testid="launch-as-agent"
          onChange={(e) => setAsAgent(e.target.checked)}
          type="checkbox"
        />
        Sign as agent instead of me
      </label>
      <p
        className="mt-1 text-xs text-black/60 dark:text-white/60"
        data-testid="launch-as-agent-explainer"
      >
        The launch record will be signed by this browser&apos;s agent key (an
        attested AI-agent identity) instead of your personal key — useful when
        an agent manages the launch&apos;s updates.
      </p>
    </>
  );
}

/** Placeholder for the derived id field: what the wizard would use. */
function slugPlaceholder(name: string): string {
  return name.trim() === "" ? "nebula" : effectiveLaunchId({ id: "", name });
}
