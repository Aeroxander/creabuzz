/**
 * The wizard's "everything else": the fields the four steps do not own —
 * launch id override, pitch and founder commitments, the token, chain and
 * admission, supply allocation, the performance ladder, raw money overrides
 * and block window, sale hooks, discussion channels, and the agent-signing
 * option. Rendered inside the create wizard's Advanced drawer and, in one
 * page, by the edit surface.
 *
 * The wizard steps own name, symbol and total supply in BOTH modes — no
 * control ever has two owners (Review-Proven Rule 7). Validation for every
 * field here lives in `lib/wizard.ts` (`publishIssues` / `editIssues`), never
 * in this file.
 */

import type { ReactNode } from "react";

import { Input } from "@/shared/ui/input";
import { isEvmAddress, type VestingConfig } from "../../models";
import type { CreateLaunchInput } from "../../use-launches";
import type { SaleCurrency } from "@creaton/core/launchpad/sale-currency.ts";
import type { FundingStatus } from "../../lib/funding";
import type { VestingIssue } from "../../lib/vesting-params";
import { effectiveLaunchId } from "../../lib/wizard";
import { FundingStatusEditor } from "../FundingStatusEditor";
import { Field } from "./fields";

/** The relay caps `buzz-channel` tags on a launch record. */
const MAX_BOUND_CHANNELS = 8;

/** Everything the advanced fields read or change — assembled by the dialog. */
export interface AdvancedFieldsState {
  id: string;
  setId(value: string): void;
  onName(value: string): void;
  name: string;
  initial: Partial<CreateLaunchInput> | undefined;
  longPitch: string;
  setLongPitch(value: string): void;
  ipList: string;
  setIpList(value: string): void;
  updateCadence: string;
  setUpdateCadence(value: string): void;
  /** The funding declaration; null is "nothing declared yet". */
  funding: FundingStatus | null;
  setFunding(next: FundingStatus | null): void;
  /** Fixed: "dao" for every new launch; "mint" or "import" only for a launch published that way before D150. */
  tokenMode: "mint" | "import" | "dao";
  /** This build has no launch contract on the chosen network, so a DAO launch cannot be sent from here yet. */
  daoKitMissing: boolean;
  tokenName: string;
  setTokenName(value: string): void;
  /** The token the record already links, shown read-only. */
  importAddress: string;
  chainId: string;
  setChainId(value: string): void;
  admission: "curated" | "community";
  setAdmission(value: "curated" | "community"): void;
  currency: string;
  setCurrency(value: string): void;
  /** What `currency` means: symbol and decimals. */
  saleCurrency: SaleCurrency;
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
  /** Raw block overrides as `parseRawBlocks` reports them. */
  rawBlocks:
    | { startBlock: number; endBlock: number; claimBlock: number }
    | null
    | "incomplete";
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

export function AdvancedFields(fields: AdvancedFieldsState): ReactNode {
  const {
    id,
    setId,
    name,
    initial,
    longPitch,
    setLongPitch,
    ipList,
    setIpList,
    updateCadence,
    setUpdateCadence,
    funding,
    setFunding,
    tokenMode,
    daoKitMissing,
    tokenName,
    setTokenName,
    importAddress,
    chainId,
    setChainId,
    admission,
    setAdmission,
    saleCurrency,
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
        label="Page address"
        hint="The web address of the launch page: lowercase letters, numbers and dashes. It cannot be changed later. Leave empty to use the name."
      >
        <Input
          id="launch-id"
          onChange={(e) => setId(e.target.value)}
          placeholder={slugPlaceholder(name)}
          value={id}
        />
      </Field>
      <div className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15">
        <FundingStatusEditor onChange={setFunding} value={funding} />
      </div>
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
            hint="What exists today, why now, and what failure would look like. The launch can't go live without it."
          >
            <textarea
              id="launch-long-pitch"
              data-testid="launch-long-pitch"
              className="w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white"
              onChange={(e) => setLongPitch(e.target.value)}
              placeholder="What is already built, who is on the team, what you will build next, and what would show the idea is wrong."
              rows={4}
              value={longPitch}
            />
          </Field>
          <Field
            id="launch-ip-list"
            label="Committed assets"
            hint="One link per line: code, documents, social accounts or web addresses you own."
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
            hint='What you commit to telling investors, for example "monthly, with numbers".'
          >
            <Input
              id="launch-update-cadence"
              data-testid="launch-update-cadence"
              onChange={(e) => setUpdateCadence(e.target.value)}
              placeholder="monthly, with numbers"
              value={updateCadence}
            />
          </Field>
        </div>
      </details>

      <div className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15">
        <span className="text-sm font-medium">
          {tokenMode === "dao" ? "Project Shares" : "Token"}
        </span>
        {tokenMode === "dao" ? (
          <div
            className="mt-2 flex flex-col gap-3"
            data-testid="token-mode-dao"
          >
            <p className="text-xs text-black/60 dark:text-white/60">
              Sell the project's own Shares. One launch creates the project's
              DAO and the sale together: the raise goes to the DAO, the team's
              Shares unlock over time, and everyone who buys can vote and leave
              with their share of the project's money. Name, symbol and total
              supply are on the first step.
            </p>
            {daoKitMissing ? (
              <p
                className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                data-testid="dao-kit-missing"
                role="status"
              >
                Launching a project with its own DAO is not set up for this
                network yet. You can save the draft, but it cannot be launched
                here until it is. Pick another network to launch now.
              </p>
            ) : null}
            <Field id="launch-token-name" label="Name">
              <Input
                id="launch-token-name"
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="Nebula"
                value={tokenName}
              />
            </Field>
          </div>
        ) : (
          <div
            className="mt-2 flex flex-col gap-3"
            data-testid="token-mode-earlier"
          >
            <p className="text-xs text-black/60 dark:text-white/60">
              This launch was published with a token made outside a project DAO,
              before new launches always sold the project&apos;s own Shares. It
              stays as it was published.
            </p>
            {isEvmAddress(importAddress) ? (
              <p className="text-xs text-black/60 dark:text-white/60">
                Token contract:{" "}
                <span className="font-mono">{importAddress}</span>
              </p>
            ) : null}
            {tokenMode === "mint" ? (
              <Field id="launch-token-name" label="Token name">
                <Input
                  id="launch-token-name"
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="Nebula Token"
                  value={tokenName}
                />
              </Field>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <Field
          id="launch-chain"
          label="Network ID"
          hint="11155111 is the Sepolia test network."
        >
          <Input
            id="launch-chain"
            onChange={(e) => setChainId(e.target.value)}
            placeholder="11155111"
            value={chainId}
          />
        </Field>
        <Field
          id="launch-admission"
          label="Bid access"
          hint="Curated: you pick who can bid. Community: anyone can bid."
        >
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
        <details
          className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
          data-testid="launch-advanced-vesting"
          {...(initial ? { open: true } : {})}
        >
          <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
            Price-based unlocks (optional)
          </summary>
          <div className="mt-3">
            <div
              className="rounded-lg border border-black/10 p-3 dark:border-white/10"
              data-testid="launch-vesting"
            >
              <p className="text-sm font-medium">Price-based unlocks</p>
              <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                Parts unlock as the token price reaches multiples of the raise
                price (2x up to 32x by default). This is recorded on the launch
                for now; the network will enforce it later, with milestone
                reviewers.
              </p>
              <label
                className="mt-2 block text-sm text-black/60 dark:text-white/60"
                htmlFor="launch-cliff"
              >
                Wait before any unlock (blocks)
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
                Parts (multiple:percent, one per line)
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
          hint="In the currency's smallest units. The price you set in the steps fills this in; type here to override it."
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
          label="Raise target (smallest units)"
          hint="The least the sale must raise, in the currency's smallest units. Miss it and every bid is refunded in full."
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
          label="Sale dates (block numbers)"
          hint="The steps fill these in from the dates you picked. Override all three, or leave them empty."
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
              aria-label="Collecting opens at block"
              data-testid="launch-claim-block"
              inputMode="numeric"
              onChange={(e) => setClaimBlockRaw(e.target.value)}
              placeholder="collect"
              value={claimBlockRaw}
            />
          </div>
          {rawBlocks === "incomplete" ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              Set all three block numbers, with collecting opening at or after
              the end, or clear them and we will work them out from your dates.
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
          Sale and money details
          <span className="ml-2 text-xs font-normal text-black/50 dark:text-white/50">
            defaults are fine to start
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field
            id="launch-budget"
            label="Monthly budget"
            hint="The monthly operating budget, in the currency's smallest units. Above a sixth of the raise target, you get a warning."
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
            label="Price step"
            hint="The gap between allowed bid prices, in the same units as the floor price."
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
            label="Sale contract"
            hint="Optional for now. Add it once the sale is created."
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
            label="Treasury (the project's money)"
            hint="Receives the newly created supply. Optional for now."
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
        attested AI-agent identity) instead of your personal key. Use it when an
        agent manages the launch&apos;s updates.
      </p>
    </>
  );
}

/** Placeholder for the derived id field: what the wizard would use. */
function slugPlaceholder(name: string): string {
  return name.trim() === "" ? "nebula" : effectiveLaunchId({ id: "", name });
}
