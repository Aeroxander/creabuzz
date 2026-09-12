import { useMemo, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { CreateLaunchInput } from "../use-launches";
import {
  isEvmAddress,
  isLaunchSlug,
  isWholeTokenSupply,
  LAUNCH_DEFAULTS,
  suggestSymbol,
} from "../models";
import {
  ALLOCATION_LABELS,
  STANDARD_ALLOCATION,
  allocationIssue,
  type SupplyAllocation,
} from "../lib/allocation";
import {
  hasBlockingIssue,
  standardLaunchPreset,
  validateLaunchParams,
} from "../lib/launch-params";
import { getRpcEndpoint, isContractDeployed } from "../chain";
import { useChannels } from "@/features/channels/use-channels";
import { Modal } from "./Modal";

/** The relay caps `buzz-channel` tags on a launch record. */
const MAX_BOUND_CHANNELS = 8;

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        className="text-sm font-medium text-black dark:text-white"
        htmlFor={id}
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? (
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">{hint}</p>
      ) : null}
    </div>
  );
}

type TokenMode = "mint" | "import";

export function CreateLaunchDialog({
  isCreating,
  onCreate,
  onClose,
  initial,
}: {
  isCreating: boolean;
  onCreate: (input: CreateLaunchInput) => Promise<void>;
  onClose: () => void;
  initial?: Partial<CreateLaunchInput>;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [pitch, setPitch] = useState(initial?.pitch ?? "");
  const [chainId, setChainId] = useState<string>(
    initial?.chainId ?? LAUNCH_DEFAULTS.chainId,
  );
  const [currency, setCurrency] = useState(initial?.currency ?? "");
  const [floorPrice, setFloorPrice] = useState<string>(
    initial?.floorPrice ?? LAUNCH_DEFAULTS.floorPrice,
  );
  const [tickSpacing, setTickSpacing] = useState<string>(
    initial?.tickSpacing ?? LAUNCH_DEFAULTS.tickSpacing,
  );
  const [requiredRaised, setRequiredRaised] = useState<string>(
    initial?.requiredRaised ?? LAUNCH_DEFAULTS.requiredRaised,
  );
  const [auction, setAuction] = useState(initial?.auction ?? "");
  const [treasury, setTreasury] = useState(initial?.treasury ?? "");
  const [admission, setAdmission] = useState<"curated" | "community">(
    initial?.admission ?? LAUNCH_DEFAULTS.admission,
  );
  /**
   * Discussion channels bound to the launch (`buzz-channel` tags).
   *
   * The record's community link is what ties a launch to the rooms where it is
   * discussed; the wizard used to always publish an empty list, so a launch
   * could never be bound to a channel from the web client.
   */
  const [allocation, setAllocation] = useState<SupplyAllocation>(
    () => initial?.allocation ?? { ...STANDARD_ALLOCATION },
  );
  const allocationMessage = allocationIssue(allocation);
  const [boundChannels, setBoundChannels] = useState<string[]>(
    initial?.channels ?? [],
  );
  const { data: channelList } = useChannels();
  const [tokenMode, setTokenMode] = useState<TokenMode>(
    initial?.token ? "import" : "mint",
  );
  // Seeded from the record: an existing launch already holds its token plan, and
  // leaving these empty made "Save changes" render disabled with no reason the
  // moment a founder opened Edit terms.
  const [tokenName, setTokenName] = useState(
    () => initial?.tokenPlan?.name ?? "",
  );
  const [symbol, setSymbol] = useState(() => initial?.tokenPlan?.symbol ?? "");
  const [supply, setSupply] = useState<string>(
    () => initial?.tokenPlan?.supply ?? LAUNCH_DEFAULTS.supply,
  );
  const [importAddress, setImportAddress] = useState(initial?.token ?? "");
  const [verifyState, setVerifyState] = useState<
    "idle" | "checking" | "ok" | "missing" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const quickStart = () => {
    setChainId(LAUNCH_DEFAULTS.chainId);
    setFloorPrice(LAUNCH_DEFAULTS.floorPrice);
    setTickSpacing(LAUNCH_DEFAULTS.tickSpacing);
    setRequiredRaised(LAUNCH_DEFAULTS.requiredRaised);
    setAdmission(LAUNCH_DEFAULTS.admission);
    setBoundChannels(initial?.channels ?? []);
    if (name.trim() !== "") {
      setTokenName(`${name.trim()} Token`);
      setSymbol((s) => s || suggestSymbol(name));
    }
  };

  const tokenValid =
    tokenMode === "mint"
      ? tokenName.trim().length > 0 &&
        symbol.trim().length > 0 &&
        isWholeTokenSupply(supply)
      : isEvmAddress(importAddress);

  /**
   * What the auction contract would reject, checked before the terms are
   * written. A launch is a one-shot deployment: the constructor reverting is
   * discovered far too late to be useful, and the defaults this form shipped
   * with could not be deployed at all.
   */
  const paramIssues = useMemo(() => {
    const asBig = (value: string) => {
      try {
        return value.trim() === "" ? 0n : BigInt(value.trim());
      } catch {
        return 0n;
      }
    };
    return validateLaunchParams({
      supply: asBig(supply) * 10n ** 18n,
      floorPrice: asBig(floorPrice),
      tickSpacing: asBig(tickSpacing),
      requiredCurrencyRaised: asBig(requiredRaised),
      // The schedule is built when the sale deploys, not in this form.
      startBlock: 0n,
      endBlock: 0n,
      claimBlock: 0n,
      steps: [],
    }).filter(
      (issue) =>
        issue.field !== "steps" &&
        issue.field !== "endBlock" &&
        issue.field !== "claimBlock",
    );
  }, [supply, floorPrice, tickSpacing, requiredRaised]);

  const paramBlocked = hasBlockingIssue(paramIssues);

  const valid =
    isLaunchSlug(id) &&
    name.trim().length > 0 &&
    (chainId.trim() === "" || /^\d+$/.test(chainId.trim())) &&
    tokenValid &&
    !paramBlocked &&
    allocationMessage === null;

  /**
   * Fill in the shape a project normally wants: a fifth of the supply at a cent
   * per token for a 10M valuation, graduating if it raises 15% of the sale's
   * floor value. Nothing is locked in — the fields stay editable.
   */
  const applyRecommendedTerms = () => {
    const preset = standardLaunchPreset({
      startBlock: 0n,
      totalSupply: 10n ** 18n * 1_000_000_000n,
    });
    setFloorPrice(preset.floorPrice.toString());
    setTickSpacing(preset.tickSpacing.toString());
    setRequiredRaised(preset.requiredCurrencyRaised.toString());
    setSupply(Number(preset.supply / 10n ** 18n).toString());
  };

  const verifyImport = async () => {
    if (!isEvmAddress(importAddress)) {
      setVerifyState("error");
      return;
    }
    setVerifyState("checking");
    try {
      const ok = await isContractDeployed(
        getRpcEndpoint(),
        importAddress.trim(),
      );
      setVerifyState(ok ? "ok" : "missing");
    } catch {
      setVerifyState("error");
    }
  };

  const submit = () => {
    if (!valid || isCreating) return;
    for (const value of [auction, treasury]) {
      if (value.trim() !== "" && !isEvmAddress(value)) {
        setError("Auction and treasury must be 0x addresses when set.");
        return;
      }
    }
    setError(null);
    void onCreate({
      id: id.trim(),
      name: name.trim(),
      pitch: pitch.trim(),
      stage: initial?.stage ?? "draft",
      chainId: chainId.trim(),
      currency: currency.trim(),
      floorPrice: floorPrice.trim(),
      tickSpacing: tickSpacing.trim(),
      requiredRaised: requiredRaised.trim(),
      auction: auction.trim(),
      token: tokenMode === "import" ? importAddress.trim() : "",
      treasury: treasury.trim(),
      admission,
      channels: boundChannels,
      allocation,
      tokenPlan:
        tokenMode === "mint"
          ? {
              mode: "mint",
              name: tokenName.trim(),
              symbol: symbol.trim(),
              supply: supply.trim(),
            }
          : undefined,
    });
  };

  return (
    <Modal label={initial ? "Edit launch" : "New launch"} onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        {initial ? "Edit launch" : "New launch"}
      </h2>
      <div className="mt-3 flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
        <Field
          id="launch-id"
          label="Launch id"
          hint="Lowercase slug. Permanent — it addresses the launch on the relay."
        >
          <Input
            id="launch-id"
            onChange={(e) => setId(e.target.value)}
            placeholder="nebula"
            value={id}
          />
        </Field>
        <Field id="launch-name" label="Name">
          <Input
            id="launch-name"
            onChange={(e) => {
              const next = e.target.value;
              // Keep the suggested token defaults in step with the name while
              // the founder has not chosen their own. The fields used to stay
              // empty — with the suggestion visible only as a placeholder — so
              // "Publish launch" stayed disabled with no visible reason.
              const previousTokenName = `${name} Token`;
              const previousSymbol = suggestSymbol(name);
              setTokenName((prev) =>
                prev === "" || prev === previousTokenName
                  ? next.trim() === ""
                    ? ""
                    : `${next.trim()} Token`
                  : prev,
              );
              setSymbol((prev) =>
                prev === "" || prev === previousSymbol
                  ? suggestSymbol(next)
                  : prev,
              );
              setName(next);
            }}
            placeholder="Nebula DAO"
            value={name}
          />
        </Field>
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
                No addresses needed. Minting deploys a reserve-backed apptoken
                and is a separate step after publishing.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field id="launch-token-name" label="Token name">
                  <Input
                    id="launch-token-name"
                    onChange={(e) => setTokenName(e.target.value)}
                    placeholder="Nebula Token"
                    value={tokenName}
                  />
                </Field>
                <Field id="launch-symbol" label="Symbol">
                  <Input
                    id="launch-symbol"
                    onChange={(e) => setSymbol(e.target.value)}
                    placeholder={suggestSymbol(name) || "NEB"}
                    value={symbol}
                  />
                </Field>
              </div>
              <Field
                id="launch-supply"
                label="Supply"
                hint="Whole tokens. 18 decimals onchain."
              >
                <Input
                  id="launch-supply"
                  onChange={(e) => setSupply(e.target.value)}
                  placeholder={LAUNCH_DEFAULTS.supply}
                  value={supply}
                />
              </Field>
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
                  Couldn&apos;t reach the chain. Format looks right; you can
                  still publish.
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
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
        <div className="grid grid-cols-2 gap-3">
          <Field
            id="launch-currency"
            label="Raise currency"
            hint="0x address, e.g. USDC. Empty = native coin."
          >
            <Input
              id="launch-currency"
              onChange={(e) => setCurrency(e.target.value)}
              placeholder="Native coin"
              value={currency}
            />
          </Field>
          <div
            className="rounded-lg border border-black/10 p-3 dark:border-white/10"
            data-testid="launch-allocation"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Supply allocation</p>
              <Button
                data-testid="launch-allocation-standard"
                onClick={() => setAllocation({ ...STANDARD_ALLOCATION })}
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
                    onChange={(event) =>
                      setAllocation((previous) => ({
                        ...previous,
                        [key]:
                          Number(event.target.value.replace(/\D/g, "")) || 0,
                      }))
                    }
                    type="number"
                    value={allocation[key]}
                  />
                  <span className="text-black/60 dark:text-white/60">
                    {hint}
                  </span>
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
          </div>
          <Field
            id="launch-floor"
            label="Floor price"
            hint="Smallest currency units."
          >
            <Input
              id="launch-floor"
              onChange={(e) => setFloorPrice(e.target.value)}
              placeholder="1000000"
              value={floorPrice}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            id="launch-threshold"
            label="Graduation threshold"
            hint="Minimum proceeds. Miss it and every bid refunds in full."
          >
            <Input
              id="launch-threshold"
              onChange={(e) => setRequiredRaised(e.target.value)}
              placeholder="1000000000"
              value={requiredRaised}
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
        </div>
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
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {paramIssues.length > 0 ? (
          <ul
            className="mt-2 space-y-0.5 text-xs"
            data-testid="launch-param-issues"
          >
            {paramIssues.map((issue) => (
              <li
                className={
                  issue.severity === "error"
                    ? "text-red-600 dark:text-red-400"
                    : "text-amber-700 dark:text-amber-300"
                }
                key={`${issue.field}-${issue.message}`}
              >
                {issue.severity === "error" ? "✗ " : "! "}
                {issue.field}: {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          data-testid="launch-recommended-terms"
          onClick={applyRecommendedTerms}
          size="sm"
          type="button"
          variant="outline"
        >
          Recommended terms
        </Button>
        <Button onClick={quickStart} size="sm" type="button" variant="ghost">
          Quick start defaults
        </Button>
        <Button disabled={!valid || isCreating} onClick={submit} type="button">
          {isCreating
            ? "Publishing…"
            : initial
              ? "Save changes"
              : "Publish launch"}
        </Button>
      </div>
    </Modal>
  );
}
