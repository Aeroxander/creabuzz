import { useState } from "react";

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
import { getRpcEndpoint, isContractDeployed } from "../chain";
import { Modal } from "./Modal";

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
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">{hint}</p>
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
  const [tokenMode, setTokenMode] = useState<TokenMode>(
    initial?.token ? "import" : "mint",
  );
  const [tokenName, setTokenName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [supply, setSupply] = useState<string>(LAUNCH_DEFAULTS.supply);
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

  const valid =
    isLaunchSlug(id) &&
    name.trim().length > 0 &&
    (chainId.trim() === "" || /^\d+$/.test(chainId.trim())) &&
    tokenValid;

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
      channels: initial?.channels ?? [],
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
            onChange={(e) => setName(e.target.value)}
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
              <p className="text-xs text-black/50 dark:text-white/50">
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
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
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
