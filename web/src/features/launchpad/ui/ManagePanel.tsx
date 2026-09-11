import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { isEvmAddress, mintCommandForPlan, type Launch } from "../models";
import { getRpcEndpoint, isContractDeployed } from "../chain";
import {
  useCreateLaunch,
  useLaunch,
  type CreateLaunchInput,
} from "../use-launches";
import { CreateLaunchDialog } from "./CreateLaunchDialog";
import { Input } from "@/shared/ui/input";

/** Mint handoff: copy-paste CLI command + paste-and-verify to link back. */
function TokenMintPanel({
  launch,
  onLink,
  saving,
}: {
  launch: Launch;
  onLink: (input: CreateLaunchInput) => Promise<void>;
  saving: boolean;
}) {
  const plan = launch.record.tokenPlan;
  const [treasury, setTreasury] = useState(launch.record.treasury ?? "");
  const [address, setAddress] = useState("");
  const [verifyState, setVerifyState] = useState<
    "idle" | "checking" | "ok" | "missing" | "error"
  >("idle");
  if (!plan) return null;
  const command = mintCommandForPlan({
    tokenName: plan.name,
    symbol: plan.symbol,
    supply: plan.supply,
    treasury: treasury || "<treasury-address>",
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Command copied.");
    } catch {
      toast.error("Copy failed — select the text manually.");
    }
  };
  const link = async () => {
    if (!isEvmAddress(address)) return;
    setVerifyState("checking");
    try {
      const ok = await isContractDeployed(getRpcEndpoint(), address.trim());
      if (!ok) {
        setVerifyState("missing");
        return;
      }
      setVerifyState("ok");
      await onLink({
        id: launch.record.id,
        name: launch.record.name,
        pitch: launch.record.pitch,
        stage: launch.record.stage,
        chainId: launch.record.chainId ?? "11155111",
        currency: launch.record.currency ?? "",
        floorPrice: launch.record.floorPrice ?? "",
        tickSpacing: "",
        requiredRaised: launch.record.requiredRaised ?? "",
        auction: launch.record.auction ?? "",
        token: address.trim(),
        treasury: launch.record.treasury ?? "",
        admission: launch.record.admission,
        channels: launch.record.channels,
      });
    } catch {
      setVerifyState("error");
    }
  };
  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold">Mint {plan.symbol}</h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        {plan.supply} {plan.symbol} · reserve-backed apptoken. Run this where
        your CLI lives (local Anvil works), then paste the address back here.
      </p>
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-black/5 px-2 py-1.5 dark:bg-white/10">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {command}
        </code>
        <Button
          onClick={() => void copy()}
          size="sm"
          type="button"
          variant="ghost"
        >
          Copy
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium" htmlFor="mint-treasury">
            Treasury
          </label>
          <Input
            id="mint-treasury"
            className="mt-1"
            onChange={(e) => setTreasury(e.target.value)}
            placeholder="0x…"
            value={treasury}
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="mint-address">
            Minted token address
          </label>
          <span className="mt-1 flex gap-1">
            <Input
              id="mint-address"
              onChange={(e) => {
                setAddress(e.target.value);
                setVerifyState("idle");
              }}
              placeholder="0x…"
              value={address}
            />
            <Button
              disabled={
                !isEvmAddress(address) || saving || verifyState === "checking"
              }
              onClick={() => void link()}
              size="sm"
              type="button"
              variant="outline"
            >
              {verifyState === "checking" ? "…" : "Link"}
            </Button>
          </span>
        </div>
      </div>
      {verifyState === "missing" ? (
        <p className="mt-1 text-xs text-amber-600">
          No contract at this address on the configured RPC.
        </p>
      ) : null}
      {verifyState === "error" ? (
        <p className="mt-1 text-xs text-amber-600">
          Couldn&apos;t reach the chain. Check the RPC endpoint.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Founder workspace: terms, stage machine, danger zone. Each control
 * publishes exactly one signed record republish — nothing fans out silently.
 */
export function ManagePanel({
  launchId,
  author,
  isDeleting,
  onDelete,
}: {
  launchId: string;
  author: string;
  isDeleting: boolean;
  onDelete: () => Promise<void>;
}) {
  const { launch } = useLaunch(launchId, author);
  const save = useCreateLaunch();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!launch) return null;
  const { record } = launch;

  const toInput = (
    overrides: Partial<CreateLaunchInput> = {},
  ): CreateLaunchInput => ({
    id: record.id,
    name: record.name,
    pitch: record.pitch,
    stage: record.stage,
    chainId: record.chainId ?? "11155111",
    currency: record.currency ?? "",
    floorPrice: record.floorPrice ?? "",
    tickSpacing: "",
    requiredRaised: record.requiredRaised ?? "",
    auction: record.auction ?? "",
    token: record.token ?? "",
    treasury: record.treasury ?? "",
    admission: record.admission,
    channels: record.channels,
    ...overrides,
  });

  const handleSave = async (input: CreateLaunchInput) => {
    try {
      await save.mutateAsync(input);
      toast.success("Launch updated.");
      setEditOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Saving failed.");
    }
  };

  const order = ["draft", "review", "live", "funding", "graduated", "failed"];
  const next = order[order.indexOf(record.stage) + 1];

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-4">
      <Card className="p-4">
        <h2 className="text-base font-semibold">Terms</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          Stage: {record.stage} · {record.admission} track · chain{" "}
          {record.chainId ?? "undeployed"}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => setEditOpen(true)} size="sm" variant="outline">
            Edit terms
          </Button>
          {next ? (
            <Button
              disabled={save.isPending}
              onClick={() =>
                void handleSave(
                  toInput({ stage: next as CreateLaunchInput["stage"] }),
                )
              }
              size="sm"
              variant="outline"
            >
              Advance to {next}
            </Button>
          ) : null}
        </div>
      </Card>

      {record.tokenPlan && !record.token ? (
        <TokenMintPanel
          launch={launch}
          onLink={handleSave}
          saving={save.isPending}
        />
      ) : null}

      <Card className="border-red-500/30 p-4">
        <h2 className="text-base font-semibold text-red-600">Danger zone</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          Removes the launch from the directory. Onchain state is untouched.
        </p>
        {confirmDelete ? (
          <div className="mt-2 flex gap-2">
            <Button
              disabled={isDeleting}
              onClick={() => void onDelete()}
              size="sm"
              variant="destructive"
            >
              {isDeleting ? "Removing…" : "Confirm removal"}
            </Button>
            <Button
              onClick={() => setConfirmDelete(false)}
              size="sm"
              variant="outline"
            >
              Keep
            </Button>
          </div>
        ) : (
          <Button
            className="mt-2"
            onClick={() => setConfirmDelete(true)}
            size="sm"
            variant="destructive"
          >
            Remove launch
          </Button>
        )}
      </Card>

      {editOpen ? (
        <CreateLaunchDialog
          initial={toInput()}
          isCreating={save.isPending}
          onCreate={handleSave}
          onClose={() => setEditOpen(false)}
        />
      ) : null}
    </div>
  );
}
