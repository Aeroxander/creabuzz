import { useChannelsQuery } from "@/features/channels/hooks";
import * as React from "react";
import { toast } from "sonner";

import {
  useUpdateLaunchRecordMutation,
  type CreateLaunchInput,
} from "@/features/launchpad/hooks";
import { mintCommandForPlan } from "@/features/launchpad/lib/launchRecord";
import {
  getRpcEndpoint,
  isContractDeployed,
} from "@/features/launchpad/lib/chainRpc";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { Input } from "@/shared/ui/input";
import { STAGE_LABELS } from "@/features/launchpad/lib/launchpadStatus";
import type { Launch, LaunchStage } from "@/features/launchpad/launchpadModels";
import { CreateLaunchDialog } from "@/features/launchpad/ui/CreateLaunchDialog";
import { Button } from "@/shared/ui/button";

const STAGE_ORDER: LaunchStage[] = [
  "draft",
  "review",
  "live",
  "funding",
  "graduated",
  "failed",
];

/**
 * Mint handoff: the exact CLI command (copy-paste), plus paste-and-verify to
 * link the deployed apptoken back to the launch. No hex typing required to
 * start — only to finish, with verification.
 */
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
  const [treasury, setTreasury] = React.useState(launch.record.treasury ?? "");
  const [address, setAddress] = React.useState("");
  const [verifyState, setVerifyState] = React.useState<
    "idle" | "checking" | "ok" | "missing" | "error"
  >("idle");
  if (!plan) return null;
  const command = mintCommandForPlan({
    tokenName: plan.name,
    symbol: plan.symbol,
    supply: plan.supply,
    treasury: treasury || "<treasury-address>",
  });
  const link = async () => {
    if (!isEvmAddressSafe(address)) return;
    setVerifyState("checking");
    try {
      const ok = await isContractDeployed(
        getRpcEndpoint(getCachedRelayOrigin()),
        address.trim(),
      );
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
    <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
      <h3 className="text-sm font-semibold">Mint {plan.symbol}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {plan.supply} {plan.symbol} · reserve-backed apptoken. Run this where
        your CLI lives (local Anvil works), then paste the address back here.
      </p>
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-2xs">
          {command}
        </code>
        <Button
          onClick={() => void copyTextToClipboard(command)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Copy
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div className="block">
          <label className="text-sm font-medium" htmlFor="mint-treasury">
            Treasury
          </label>
          <span className="mt-1 block">
            <Input
              id="mint-treasury"
              onChange={(e) => setTreasury(e.target.value)}
              placeholder="0x…"
              value={treasury}
            />
          </span>
        </div>
        <div className="block">
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
                !isEvmAddressSafe(address) ||
                saving ||
                verifyState === "checking"
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
        <p className="mt-1 text-2xs text-amber-600">
          No contract at this address on the configured RPC.
        </p>
      ) : null}
      {verifyState === "error" ? (
        <p className="mt-1 text-2xs text-amber-600">
          Couldn&apos;t reach the chain. Check the RPC endpoint.
        </p>
      ) : null}
    </section>
  );
}

function isEvmAddressSafe(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * Founder workspace: terms, community links, stage machine, danger zone.
 * One user action = one atomic persist — each control publishes exactly one
 * signed record republish; nothing here fans out silently.
 */
export function LaunchManagePanel({
  launch,
  isDeleting,
  onDelete,
}: {
  launch: Launch;
  isDeleting: boolean;
  onDelete: () => Promise<void>;
}) {
  const updateMutation = useUpdateLaunchRecordMutation();
  const channelsQuery = useChannelsQuery();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const { record } = launch;

  const toInput = React.useCallback(
    (overrides: Partial<CreateLaunchInput> = {}): CreateLaunchInput => ({
      id: record.id,
      name: record.name,
      pitch: record.pitch,
      stage: record.stage,
      chainId: record.chainId ?? "11155111",
      currency: record.currency ?? "",
      floorPrice: record.floorPrice ?? "",
      tickSpacing: record.tickSpacing ?? "",
      requiredRaised: record.requiredRaised ?? "",
      auction: record.auction ?? "",
      token: record.token ?? "",
      treasury: record.treasury ?? "",
      admission: record.admission,
      channels: record.channels,
      ...overrides,
    }),
    [record],
  );

  const handleSave = React.useCallback(
    async (input: CreateLaunchInput) => {
      try {
        await updateMutation.mutateAsync(input);
        toast.success("Launch updated.");
        setEditOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Saving failed.");
      }
    },
    [updateMutation],
  );

  const linked = new Set(record.channels);
  const toggleChannel = (channelId: string) => {
    const next = linked.has(channelId)
      ? record.channels.filter((c) => c !== channelId)
      : [...record.channels, channelId];
    void handleSave(toInput({ channels: next }));
  };

  const advanceStage = (stage: LaunchStage) => {
    void handleSave(toInput({ stage }));
  };

  const stageIndex = STAGE_ORDER.indexOf(record.stage);
  const nextStage =
    stageIndex >= 0 && stageIndex < STAGE_ORDER.length - 1
      ? STAGE_ORDER[stageIndex + 1]
      : null;

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-3">
      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Terms</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Stage: {STAGE_LABELS[record.stage]} · {record.admission} track · chain{" "}
          {record.chainId ?? "undeployed"}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            onClick={() => setEditOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Edit terms
          </Button>
          {nextStage ? (
            <Button
              disabled={updateMutation.isPending}
              onClick={() => advanceStage(nextStage)}
              size="sm"
              type="button"
              variant="outline"
            >
              Advance to {STAGE_LABELS[nextStage]}
            </Button>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
        <h3 className="text-sm font-semibold">Community channels</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Announcements and discussion live in the community. Link channels so
          investors find them from this launch.
        </p>
        {channelsQuery.isLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Loading channels…
          </p>
        ) : (channelsQuery.data ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No joined channels in this community yet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {(channelsQuery.data ?? []).map((channel) => {
              const on = linked.has(channel.id);
              return (
                <li key={channel.id}>
                  <button
                    aria-pressed={on}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => toggleChannel(channel.id)}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className={`flex h-4 w-4 items-center justify-center rounded border text-2xs ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="font-medium">#{channel.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {launch.record.tokenPlan && !launch.record.token ? (
        <TokenMintPanel
          launch={launch}
          onLink={handleSave}
          saving={updateMutation.isPending}
        />
      ) : null}

      <section className="rounded-2xl border border-destructive/30 px-4 py-3">
        <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Removes the launch from the directory. Onchain state is untouched —
          deletion only hides the card.
        </p>
        {confirmDelete ? (
          <div className="mt-2 flex gap-2">
            <Button
              disabled={isDeleting}
              onClick={() => void onDelete()}
              size="sm"
              type="button"
              variant="destructive"
            >
              {isDeleting ? "Removing…" : "Confirm removal"}
            </Button>
            <Button
              onClick={() => setConfirmDelete(false)}
              size="sm"
              type="button"
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
            type="button"
            variant="destructive"
          >
            Remove launch
          </Button>
        )}
      </section>

      <CreateLaunchDialog
        initial={toInput()}
        isCreating={updateMutation.isPending}
        onCreate={handleSave}
        onOpenChange={setEditOpen}
        open={editOpen}
      />
    </div>
  );
}
