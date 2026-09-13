import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  hasFounderCommitments,
  isEvmAddress,
  mintCommandForPlan,
  type Launch,
} from "../models";
import { toAtomic } from "../lib/amounts";
import { hasBlockingIssue, validateLaunchParams } from "../lib/launch-params";
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
        tickSpacing: launch.record.tickSpacing ?? "",
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
  /** Destructive stage change: confirmed inline, like the delete below. */
  const [confirmRegress, setConfirmRegress] = useState<"failed" | null>(null);
  /** Open the editor seeded for a relaunch (fresh stage, cleared chain links). */
  const [relaunchSeed, setRelaunchSeed] = useState(false);
  if (!launch) return null;
  const { record } = launch;

  /**
   * The record as an edit input.
   *
   * Every field the record holds has to survive here, or an action that only
   * means to change one of them erases the rest: `tickSpacing` was reset to ""
   * and `tokenPlan` was dropped on *every* save, so terms the founder had set
   * disappeared and the mint handoff vanished for good (the Mint panel is gated
   * on `tokenPlan`, so it could never come back).
   */
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
    tickSpacing: record.tickSpacing ?? "",
    requiredRaised: record.requiredRaised ?? "",
    auction: record.auction ?? "",
    token: record.token ?? "",
    treasury: record.treasury ?? "",
    admission: record.admission,
    channels: record.channels,
    ...(record.tokenPlan ? { tokenPlan: record.tokenPlan } : {}),
    ...(record.vesting ? { vesting: record.vesting } : {}),
    ...overrides,
  });

  /**
   * Relaunch a failed launch: republish the SAME record id (`d`) with a fresh
   * stage and cleared chain links. The community and discussion history keep
   * their identity; the new auction is a new deploy.
   */
  const handleRelaunch = () => {
    // Open the editor seeded from the record but reset to a fresh start:
    // stage back to draft, and the chain links cleared so the founder links
    // the new deployment rather than reusing a dead one.
    setRelaunchSeed(true);
    setEditOpen(true);
  };

  const handleSave = async (input: CreateLaunchInput) => {
    try {
      await save.mutateAsync(input);
      toast.success("Launch updated.");
      setEditOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Saving failed.");
    }
  };

  /**
   * Forward stages only, and never out of a terminal one.
   *
   * `failed` is not the step after `graduated`; the list was a single ordered
   * array, so a graduated launch offered "Advance to failed" with no
   * confirmation and no way back.
   */
  const order = ["draft", "review", "live", "funding", "graduated"] as const;
  const terminal = record.stage === "graduated" || record.stage === "failed";
  const next = terminal
    ? undefined
    : order[order.indexOf(record.stage as (typeof order)[number]) + 1];

  /**
   * Founder commitments the record must carry before the launch leaves
   * `review` for `live`: a real story, a bound discussion channel, and a
   * committed budget. Numeric validity makes a deployable auction; these make
   * an investor able to judge the person running it (the MetaDAO funnel
   * lesson: qualification is the product).
   */
  const founderReady = hasFounderCommitments(record);

  /**
   * What is set and what is still missing.
   *
   * A founder publishing terms cannot see which of them the chain will need, so
   * the gaps that block a deployment are listed here rather than discovered by a
   * reverting constructor.
   */
  const readiness: Array<{ label: string; ok: boolean; hint: string }> = [
    {
      label: "Sale parameters",
      ok: !hasBlockingIssue(
        validateLaunchParams({
          supply: (toAtomic(record.tokenPlan?.supply) ?? 0n) * 10n ** 18n,
          floorPrice: toAtomic(record.floorPrice) ?? 0n,
          tickSpacing: toAtomic(record.tickSpacing) ?? 0n,
          requiredCurrencyRaised: toAtomic(record.requiredRaised) ?? 0n,
          budget: toAtomic(record.budget) ?? 0n,
          startBlock: 0n,
          endBlock: 0n,
          claimBlock: 0n,
          steps: [],
        }).filter(
          (issue) =>
            issue.field !== "steps" &&
            issue.field !== "endBlock" &&
            issue.field !== "claimBlock",
        ),
      ),
      hint: "Floor price on the tick grid, above the contract minimum.",
    },
    {
      label: "Token",
      ok: Boolean(record.token || record.tokenPlan),
      hint: "Mint the token or link a deployed address.",
    },
    {
      label: "Auction contract",
      ok: Boolean(record.auction),
      hint: "Deploy the auction and link it, so bids have somewhere to go.",
    },
    {
      label: "Treasury",
      ok: Boolean(record.treasury),
      hint: "Where the raise and the retained supply are held.",
    },
    {
      label: "Discussion channel",
      ok: record.channels.length > 0,
      hint: "Bind the channel where the launch is discussed.",
    },
    {
      label: "Founder commitments",
      ok: founderReady,
      hint: "The long pitch, an update cadence, and a bound channel let investors judge the team, not just the numbers.",
    },
  ];
  const open = readiness.filter((item) => !item.ok).length;

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-4">
      <Card className="p-4" data-testid="launch-readiness">
        <h2 className="text-base font-semibold">Launch readiness</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          {open === 0
            ? "Everything the chain needs is set."
            : `${open} step${open === 1 ? "" : "s"} still open before this can deploy.`}
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {readiness.map((item) => (
            <li className="flex items-start gap-2 text-sm" key={item.label}>
              <span
                aria-hidden="true"
                className={item.ok ? "text-emerald-600" : "text-amber-600"}
              >
                {item.ok ? "✓" : "•"}
              </span>
              <span>
                <span className="font-medium">{item.label}</span>
                <span className="sr-only">{item.ok ? ": set" : ": open"}</span>
                {!item.ok ? (
                  <span className="block text-xs text-black/60 dark:text-white/60">
                    {item.hint}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4" data-testid="launch-graduation">
        <h2 className="text-base font-semibold">Graduation</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          At graduation the executes-and-moves contract (set as the auction's
          funds and tokens recipient at deploy) sweeps the raise, forwards the
          treasury share, escrows the reserve for the TokenMaster floor, and
          returns unsold tokens. Apptoken rails, not a v4 pool.
        </p>
        <p className="mt-2 text-xs text-black/60 dark:text-white/60">
          The reserve releases only to the recorded pool by treasury action; if
          the pool never lands, the treasury can withdraw the stuck reserve. The
          chain is the ledger — this panel states the mechanism; the contract
          moves the money.
        </p>
      </Card>
      <Card className="p-4">
        <h2 className="text-base font-semibold">Terms</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          Stage: {record.stage} · {record.admission} track · chain{" "}
          {record.chainId ?? "undeployed"}
        </p>
        {confirmRegress === "failed" ? (
          <div className="mt-2 flex flex-wrap gap-2" role="alert">
            <span className="text-xs text-red-700 dark:text-red-400">
              Marking the launch failed is permanent from here.
            </span>
            <Button
              disabled={save.isPending}
              onClick={() => {
                setConfirmRegress(null);
                void handleSave(toInput({ stage: "failed" }));
              }}
              size="sm"
              variant="destructive"
            >
              Confirm failure
            </Button>
            <Button
              onClick={() => setConfirmRegress(null)}
              size="sm"
              variant="outline"
            >
              Keep as is
            </Button>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={() => setEditOpen(true)} size="sm" variant="outline">
            Edit terms
          </Button>
          {next ? (
            <Button
              disabled={save.isPending || (next === "live" && !founderReady)}
              onClick={() =>
                void handleSave(
                  toInput({ stage: next as CreateLaunchInput["stage"] }),
                )
              }
              size="sm"
              variant="outline"
            >
              {next === "live" && !founderReady
                ? "Add founder commitments first"
                : `Advance to ${next}`}
            </Button>
          ) : null}
          {record.stage !== "failed" ? (
            <Button
              disabled={save.isPending}
              onClick={() => setConfirmRegress("failed")}
              size="sm"
              variant="ghost"
            >
              Mark as failed
            </Button>
          ) : (
            <Button
              data-testid="launch-relaunch"
              disabled={save.isPending}
              onClick={() => handleRelaunch()}
              size="sm"
              variant="outline"
            >
              Relaunch this launch
            </Button>
          )}
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
          initial={
            relaunchSeed
              ? {
                  ...toInput(),
                  stage: "draft",
                  auction: "",
                  token: "",
                  treasury: "",
                }
              : toInput()
          }
          relaunchNote={
            relaunchSeed
              ? "This republishes the same launch record — the community and history stay. Link a new auction when it deploys."
              : undefined
          }
          isCreating={save.isPending}
          onCreate={handleSave}
          onClose={() => {
            setEditOpen(false);
            setRelaunchSeed(false);
          }}
        />
      ) : null}
    </div>
  );
}
