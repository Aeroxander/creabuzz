import * as React from "react";

import type { CreateLaunchInput } from "@/features/launchpad/hooks";
import {
  isEvmAddress,
  isLaunchSlug,
  isWholeTokenSupply,
  LAUNCH_DEFAULTS,
  suggestSymbol,
} from "@/features/launchpad/lib/launchRecord";
import {
  getRpcEndpoint,
  isContractDeployed,
} from "@/features/launchpad/lib/chainRpc";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

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
    <div className="block">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <span className="mt-1 block">{children}</span>
      {hint ? (
        <span className="mt-1 block text-2xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

type TokenMode = "mint" | "import";

/**
 * Founder wizard: identity, token (mint or import), and raise terms.
 * Mint mode never asks for hex — name, symbol, and whole-token supply are
 * enough; the exact mint command is shown after publishing.
 */
export function CreateLaunchDialog({
  isCreating,
  onCreate,
  onOpenChange,
  open,
  initial,
}: {
  isCreating: boolean;
  onCreate: (input: CreateLaunchInput) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  initial?: Partial<CreateLaunchInput>;
}) {
  const [id, setId] = React.useState(initial?.id ?? "");
  const [name, setName] = React.useState(initial?.name ?? "");
  const [pitch, setPitch] = React.useState(initial?.pitch ?? "");
  const [chainId, setChainId] = React.useState(
    initial?.chainId ?? LAUNCH_DEFAULTS.chainId,
  );
  const [currency, setCurrency] = React.useState(initial?.currency ?? "");
  const [floorPrice, setFloorPrice] = React.useState(
    initial?.floorPrice ?? LAUNCH_DEFAULTS.floorPrice,
  );
  const [tickSpacing, setTickSpacing] = React.useState(
    initial?.tickSpacing ?? LAUNCH_DEFAULTS.tickSpacing,
  );
  const [requiredRaised, setRequiredRaised] = React.useState(
    initial?.requiredRaised ?? LAUNCH_DEFAULTS.requiredRaised,
  );
  const [auction, setAuction] = React.useState(initial?.auction ?? "");
  const [treasury, setTreasury] = React.useState(initial?.treasury ?? "");
  const [admission, setAdmission] = React.useState<"curated" | "community">(
    initial?.admission ?? LAUNCH_DEFAULTS.admission,
  );
  const [tokenMode, setTokenMode] = React.useState<TokenMode>(
    initial?.token ? "import" : "mint",
  );
  const [tokenName, setTokenName] = React.useState("");
  const [symbol, setSymbol] = React.useState("");
  const [supply, setSupply] = React.useState<string>(LAUNCH_DEFAULTS.supply);
  const [importAddress, setImportAddress] = React.useState(
    initial?.token ?? "",
  );
  const [verifyState, setVerifyState] = React.useState<
    "idle" | "checking" | "ok" | "missing" | "error"
  >("idle");
  const [error, setError] = React.useState<string | null>(null);

  const wasOpen = React.useRef(open);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset-on-open only; field edits must not be clobbered by re-renders
  React.useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    setId(initial?.id ?? "");
    setName(initial?.name ?? "");
    setPitch(initial?.pitch ?? "");
    setError(null);
    setVerifyState("idle");
    if (!initial) {
      setTokenName("");
      setSymbol("");
    }
  }, [open]);

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
        getRpcEndpoint(getCachedRelayOrigin()),
        importAddress.trim(),
      );
      setVerifyState(ok ? "ok" : "missing");
    } catch {
      setVerifyState("error");
    }
  };

  const submit = () => {
    if (!valid || isCreating) return;
    if ([auction, treasury].some((v) => v.trim() !== "" && !isEvmAddress(v))) {
      setError("Auction and treasury must be 0x addresses when set.");
      return;
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
    <Dialog
      onOpenChange={(next) => {
        if (!next && isCreating) return;
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent aria-label={initial ? "Edit launch" : "New launch"}>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit launch" : "New launch"}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-1 py-2">
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
            <Textarea
              id="launch-pitch"
              onChange={(e) => setPitch(e.target.value)}
              placeholder="What problem gets solved, and why now?"
              rows={3}
              value={pitch}
            />
          </Field>

          <div className="rounded-xl border border-border/70 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Token</span>
              <div className="flex gap-1 rounded-lg bg-muted p-1">
                {(["mint", "import"] as const).map((mode) => (
                  <button
                    key={mode}
                    aria-pressed={tokenMode === mode}
                    onClick={() => setTokenMode(mode)}
                    className={`rounded-md px-2 py-1 text-sm capitalize ${tokenMode === mode ? "bg-card shadow-sm" : "text-muted-foreground"}`}
                    type="button"
                  >
                    {mode === "mint" ? "Mint new" : "Import"}
                  </button>
                ))}
              </div>
            </div>
            {tokenMode === "mint" ? (
              <div className="mt-2 flex flex-col gap-3">
                <p className="text-2xs text-muted-foreground">
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
                        !isEvmAddress(importAddress) ||
                        verifyState === "checking"
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
                  <p className="mt-1 text-2xs text-emerald-600">
                    Contract found onchain.
                  </p>
                ) : null}
                {verifyState === "missing" ? (
                  <p className="mt-1 text-2xs text-amber-600">
                    No contract at this address on the configured RPC — check
                    the address or the chain.
                  </p>
                ) : null}
                {verifyState === "error" ? (
                  <p className="mt-1 text-2xs text-amber-600">
                    Couldn&apos;t reach the chain. Format looks right; you can
                    still publish.
                  </p>
                ) : null}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              id="launch-chain"
              label="Chain id"
              hint="11155111 = Sepolia."
            >
              <Input
                id="launch-chain"
                onChange={(e) => setChainId(e.target.value)}
                placeholder="11155111"
                value={chainId}
              />
            </Field>
            <Field id="launch-admission" label="Admission track">
              <div className="flex gap-1 rounded-lg bg-muted p-1">
                {(["curated", "community"] as const).map((track) => (
                  <button
                    key={track}
                    aria-pressed={admission === track}
                    onClick={() => setAdmission(track)}
                    className={`flex-1 rounded-md px-2 py-1 text-sm capitalize ${admission === track ? "bg-card shadow-sm" : "text-muted-foreground"}`}
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
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button onClick={quickStart} size="sm" type="button" variant="ghost">
            Quick start defaults
          </Button>
          <Button
            disabled={!valid || isCreating}
            onClick={submit}
            type="button"
          >
            {isCreating
              ? "Publishing…"
              : initial
                ? "Save changes"
                : "Publish launch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
