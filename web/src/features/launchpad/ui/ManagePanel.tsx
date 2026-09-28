import { useReducer, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import {
  hasFounderCommitments,
  isEvmAddress,
  mintCommandForPlan,
  type Launch,
} from "../models";
import { toAtomic } from "../lib/amounts";
import { hasBlockingIssue, validateLaunchParams } from "../lib/launch-params";
import {
  EVIDENCE_HASH_RE,
  TX_HASH_HINT,
  claimReceiptParts,
  isTxHash,
  verdictReceiptParts,
} from "../lib/milestone-receipt";
import { ethCall, getRpcEndpoint, isContractDeployed } from "../chain";
import {
  initMintFlow,
  type MintAttemptInput,
  mintFlowReducer,
  MINT_STEPS,
  retryMintAttempt,
  retryPlan,
  runMintAttempt,
} from "../lib/mint-flow";
import {
  useCreateLaunch,
  useLaunch,
  usePublishMirror,
  type CreateLaunchInput,
} from "../use-launches";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { CreateLaunchDialog } from "./CreateLaunchDialog";
import { Input } from "@/shared/ui/input";
import { autoFill, milestoneChoices } from "../lib/claim-choices";
import { HashPicker } from "./HashPicker";
import {
  resolveSender,
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "./SenderPicker";
import {
  type OnchainCall,
  planClaimSubmit,
  planVerdictSubmit,
} from "../lib/claim-submit";

/**
 * One-click "Deploy token": the `DeployAppToken.s.sol` sequence through the
 * sender picker (wallet vs sponsored passkey). The composer
 * (`lib/mint-tx.ts`) is shared and byte-identical across senders; the SEND
 * strategy differs — the sponsored sender batches the 3 calls into ONE UserOp
 * (kernel-0.3.3 CALLTYPE_BATCH, atomic), the injected wallet sends 3
 * sequential transactions (each receipt awaited before the next). Preflight,
 * the CREATE2 code check (idempotent retry), and the record write-back run
 * exactly as desktop `lib/mintFlow.ts` prescribes.
 */
function DeployTokenFlow({
  launch,
  onLink,
}: {
  launch: Launch;
  onLink: (input: CreateLaunchInput) => Promise<void>;
}) {
  const plan = launch.record.tokenPlan;
  const picker = useSenderPicker();
  const [state, dispatch] = useReducer(
    mintFlowReducer,
    undefined,
    initMintFlow,
  );
  const [running, setRunning] = useState(false);
  if (!plan) return null;

  const attemptInput = async (): Promise<MintAttemptInput> => {
    const sender = resolveSender(picker);
    const deployer = await sender.getAddress();
    const toSenderCall = (call: {
      to: string;
      data: string;
      value: string;
    }) => ({ to: call.to, data: call.data, value: call.value });
    return {
      plan: {
        name: plan.name,
        symbol: plan.symbol,
        supply: plan.supply,
        recordTreasury: launch.record.treasury,
      },
      deployer,
      strategy: picker.kind === "passkey" ? "batched" : "sequential",
      effects: {
        call: (target) => ethCall(getRpcEndpoint(), target.to, target.data),
        send: async (call) => {
          const result = await sender.sendCalls([toSenderCall(call)]);
          return { txHash: result.txHash, status: "success" as const };
        },
        sendBatch: async (calls) => {
          const result = await sender.sendCalls(calls.map(toSenderCall));
          return { txHash: result.txHash, status: "success" as const };
        },
        isDeployed: (tokenAddress) =>
          isContractDeployed(getRpcEndpoint(), tokenAddress),
      },
      link: (token) =>
        onLink({
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
          token,
          // Desktop `mintHooks.linkRecord` writes the deployer back as
          // treasury (the v1 gate requires deployer == treasury anyway).
          treasury: deployer,
          admission: launch.record.admission,
          channels: launch.record.channels,
        }),
      dispatch,
      state,
    };
  };

  const start = async () => {
    setRunning(true);
    try {
      await runMintAttempt(await attemptInput(), "fresh");
    } catch (err) {
      toast.error(senderErrorMessage(err, "Deploy failed."));
    } finally {
      setRunning(false);
    }
  };

  const retry = async () => {
    setRunning(true);
    try {
      const kind = await retryMintAttempt(await attemptInput());
      if (kind === "nothing") toast.error("Nothing left to retry.");
    } catch (err) {
      toast.error(senderErrorMessage(err, "Retry failed."));
    } finally {
      setRunning(false);
    }
  };

  const planToRetry = retryPlan(state);
  const busy =
    state.phase === "preparing" ||
    state.phase === "running" ||
    state.phase === "linking";
  return (
    <div className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <h3 className="text-sm font-semibold text-black dark:text-white">
        Deploy token here
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Runs the deploy script&apos;s three calls in the browser. The passkey
        path sends them as one sponsored, atomic UserOp; the wallet path sends
        three sequential transactions.
      </p>
      <SenderPickerControls state={picker} testIdPrefix="mint-" />
      <ol className="mt-3 flex flex-col gap-1">
        {MINT_STEPS.map((step, index) => (
          <li
            className="flex items-center justify-between text-sm text-black/80 dark:text-white/80"
            key={step.id}
          >
            <span>{step.label}</span>
            <span data-testid={`mint-step-${step.id}`}>
              {state.steps[index].status}
              {state.steps[index].txHash
                ? ` · ${state.steps[index].txHash}`
                : ""}
            </span>
          </li>
        ))}
        <li className="flex items-center justify-between text-sm text-black/80 dark:text-white/80">
          <span>Record mirror (token tag)</span>
          <span data-testid="mint-step-link">
            {state.phase === "linking"
              ? "linking"
              : state.phase === "success"
                ? "done"
                : state.failure?.stage === "link"
                  ? "failed"
                  : "pending"}
          </span>
        </li>
      </ol>
      {state.failure ? (
        <p
          className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
          data-testid="mint-failure"
        >
          {state.failure.stage === "prepare"
            ? `Preflight blocked (${state.failure.check}) — ${state.failure.reason}`
            : state.failure.stage === "link"
              ? `Mirror failed — the deploy landed at ${state.tokenAddress ?? "the computed address"}; only the record write needs retrying. ${state.failure.reason}`
              : `${MINT_STEPS[state.failure.stepIndex ?? 0].label} failed — ${state.failure.reason}`}
        </p>
      ) : null}
      {state.phase === "success" ? (
        <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Deployed and linked: {state.tokenAddress}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          data-testid="mint-deploy"
          disabled={busy || running || state.phase === "success"}
          onClick={() => void start()}
          size="sm"
          type="button"
        >
          {busy || running ? "Working…" : "Deploy token"}
        </Button>
        {planToRetry ? (
          <Button
            data-testid="mint-retry"
            disabled={busy || running}
            onClick={() => void retry()}
            size="sm"
            type="button"
            variant="outline"
          >
            {planToRetry.kind === "record"
              ? "Retry record write"
              : `Retry from step ${planToRetry.resumeAt + 1}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

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
        {plan.supply} {plan.symbol} · reserve-backed apptoken. Deploy from this
        browser below, or run the CLI where your keys live and paste the address
        back here.
      </p>
      <DeployTokenFlow launch={launch} onLink={onLink} />
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
  const mirror = usePublishMirror();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [claimId, setClaimId] = useState("");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [txHash, setTxHash] = useState("");
  // The "no manual hashes" layer: every choice on this panel is derived
  // from the wizard's plan rows and this launch's receipts.
  const milestoneChoicesList = milestoneChoices(
    launch?.record.unlocks ?? null,
    launch?.receipts ?? [],
  );
  const [onchainSending, setOnchainSending] = useState(false);
  // The milestone panel's own sender picker (the deploy card keeps its own).
  const milestoneSender = useSenderPicker();
  const [milestoneError, setMilestoneError] = useState<string | null>(null);
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
    // Preserve everything the record already holds that this editor does not
    // control: the founder commitments, the money fields, the split, the
    // signer, and (from the wizard) the window, the unlock plan and the
    // DAO-at-graduation choice. A save that drops any of them silently
    // rewrites what investors were shown (Review-Proven Rule 1).
    longPitch: record.longPitch ?? "",
    ipList: record.ipList,
    updateCadence: record.updateCadence ?? "",
    budget: record.budget ?? "",
    allocation: record.allocation,
    startBlock: record.startBlock ?? undefined,
    endBlock: record.endBlock ?? undefined,
    claimBlock: record.claimBlock ?? undefined,
    ...(record.unlocks ? { unlocks: record.unlocks } : {}),
    ...(record.daoAtGraduation !== null
      ? { daoAtGraduation: record.daoAtGraduation }
      : {}),
    ...(record.tokenPlan ? { tokenPlan: record.tokenPlan } : {}),
    ...(record.vesting ? { vesting: record.vesting } : {}),
    ...overrides,
  });

  /**
   * Relaunch a failed launch: republish the SAME record id (`d`) with a fresh
   * stage and cleared chain links. The community and discussion history keep
   * their identity; the new auction is a new deploy.
   */
  const recordClaim = async () => {
    setMilestoneError(null);
    if (!EVIDENCE_HASH_RE.test(evidenceHash.trim())) {
      setMilestoneError("Evidence hash must be 64 hex characters.");
      return;
    }
    if (!isTxHash(txHash)) {
      setMilestoneError(TX_HASH_HINT);
      return;
    }
    try {
      await mirror.mutateAsync({
        kind: KIND_LAUNCH_RECEIPT,
        author: record.author,
        launchId: record.id,
        ...claimReceiptParts({
          claimId: claimId.trim(),
          evidenceHash: evidenceHash.trim().toLowerCase(),
          tx: txHash.trim(),
        }),
      });
    } catch (err) {
      setMilestoneError(
        err instanceof Error ? err.message : "Failed to record the claim.",
      );
    }
  };

  const recordVerdict = async (approve: boolean) => {
    setMilestoneError(null);
    if (!isTxHash(txHash)) {
      setMilestoneError(TX_HASH_HINT);
      return;
    }
    try {
      await mirror.mutateAsync({
        kind: KIND_LAUNCH_RECEIPT,
        author: record.author,
        launchId: record.id,
        ...verdictReceiptParts({
          claimId: claimId.trim(),
          verdict: approve ? "approve" : "reject",
          tx: txHash.trim(),
        }),
      });
    } catch (err) {
      setMilestoneError(
        err instanceof Error ? err.message : "Failed to record the verdict.",
      );
    }
  };

  /**
   * The onchain half of the record flow (token-lifecycle-design.md): submit
   * the claim or the verdict to the launch's ClaimStake / VerifierSet through
   * the resolved sender, then prefill the settlement hash for the receipt.
   * Falls back to plain error copy when the launch is not wired onchain yet —
   * the mirror-only flow still applies then.
   */
  const submitOnchain = async (
    kind: "claim" | "verdict-approve" | "verdict-reject",
  ) => {
    setMilestoneError(null);
    setOnchainSending(true);
    try {
      let call: OnchainCall | null = null;
      if (kind === "claim") {
        const row = record.unlocks?.milestones.find(
          (m) => m.claim === claimId.trim(),
        );
        call = row
          ? (planClaimSubmit({
              record,
              row,
              evidenceHash: evidenceHash.trim(),
            })?.call ?? null)
          : null;
      } else {
        call = planVerdictSubmit(
          record,
          claimId.trim(),
          kind === "verdict-approve",
        );
      }
      if (!call) {
        setMilestoneError(
          "This launch is not wired onchain yet (deploy the enforcer and link ClaimStake/VerifierSet on the record).",
        );
        return;
      }
      const sender = resolveSender(milestoneSender);
      const result = await sender.sendCalls([call]);
      if (!isTxHash(result.txHash)) {
        throw new Error("The sender returned an invalid hash.");
      }
      setTxHash(result.txHash); // prefill for the receipt
    } catch (err) {
      setMilestoneError(
        senderErrorMessage(err, "The onchain submit was not sent."),
      );
    } finally {
      setOnchainSending(false);
    }
  };

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
          At graduation the executor contract — set as the auction's funds and
          tokens recipient at deploy — sweeps the raise, pays the treasury
          share, locks the liquidity reserve, and returns unsold tokens.
        </p>
        <p className="mt-2 text-xs text-black/60 dark:text-white/60">
          The reserve releases only to the recorded pool by treasury action; if
          the pool never lands, the treasury can withdraw the stuck reserve. The
          chain is the ledger — this panel states the mechanism; the contract
          moves the money.
        </p>
      </Card>

      <details
        className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
        data-testid="launch-advanced-milestones"
      >
        <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
          Milestone attestation
          <span className="ml-2 text-xs font-normal text-black/50 dark:text-white/50">
            post-graduation — staked claims settled onchain
          </span>
        </summary>
        <div className="mt-3" data-testid="launch-milestones">
          <h2 className="text-base font-semibold">Milestone attestation</h2>
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            A milestone claim is staked and settled onchain by the verifier set;
            this panel mirrors the claim and your verdict onto the feed (47005,
            advisory). Every mirror names the tx that settled it — the relay
            refuses a receipt without one. The chain is the ledger.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <HashPicker
              id="claim-id"
              label="Claim id"
              onValueChange={(v) => {
                setClaimId(v);
                // One dropdown drives the rest: known evidence + tx follow
                // the claim; unknown values stay empty (never guessed).
                const fill = autoFill(milestoneChoicesList, v);
                if (fill.evidenceHash) setEvidenceHash(fill.evidenceHash);
                if (fill.txHash) setTxHash(fill.txHash);
              }}
              options={milestoneChoicesList.claimOptions}
              placeholder="milestone-1"
              testId="claim-id"
              value={claimId}
            />
            <HashPicker
              id="evidence-hash"
              label="Evidence hash"
              onValueChange={setEvidenceHash}
              options={milestoneChoicesList.evidenceByClaim[claimId] ?? []}
              placeholder="64 hex chars of the canonical claim"
              testId="evidence-hash"
              value={evidenceHash}
            />
            <HashPicker
              id="milestone-tx"
              label="Settlement tx hash"
              onValueChange={setTxHash}
              options={milestoneChoicesList.txByClaim[claimId] ?? []}
              placeholder="0x + 64 hex chars of the onchain tx"
              testId="milestone-tx"
              value={txHash}
            />
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                data-testid="record-claim"
                disabled={
                  claimId.trim() === "" ||
                  !EVIDENCE_HASH_RE.test(evidenceHash.trim()) ||
                  !isTxHash(txHash) ||
                  mirror.isPending
                }
                onClick={() => void recordClaim()}
                size="sm"
                type="button"
              >
                Record claim
              </Button>
              <Button
                data-testid="verdict-approve"
                disabled={
                  claimId.trim() === "" || !isTxHash(txHash) || mirror.isPending
                }
                onClick={() => void recordVerdict(true)}
                size="sm"
                variant="outline"
                type="button"
              >
                Verdict: approve
              </Button>
              <Button
                data-testid="verdict-reject"
                disabled={
                  claimId.trim() === "" || !isTxHash(txHash) || mirror.isPending
                }
                onClick={() => void recordVerdict(false)}
                size="sm"
                variant="outline"
                type="button"
              >
                Verdict: reject
              </Button>
            </div>
            <div className="mt-1">
              <SenderPickerControls
                state={milestoneSender}
                testIdPrefix="milestone-"
              />
            </div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                data-testid="submit-claim-onchain"
                disabled={
                  onchainSending ||
                  claimId.trim() === "" ||
                  !EVIDENCE_HASH_RE.test(evidenceHash.trim())
                }
                onClick={() => void submitOnchain("claim")}
                size="sm"
                type="button"
                variant="outline"
              >
                Submit claim onchain
              </Button>
              <Button
                data-testid="attest-approve"
                disabled={onchainSending || claimId.trim() === ""}
                onClick={() => void submitOnchain("verdict-approve")}
                size="sm"
                type="button"
                variant="outline"
              >
                Attest approve
              </Button>
              <Button
                data-testid="attest-reject"
                disabled={onchainSending || claimId.trim() === ""}
                onClick={() => void submitOnchain("verdict-reject")}
                size="sm"
                type="button"
                variant="outline"
              >
                Attest reject
              </Button>
            </div>
            {milestoneError ? (
              <SignRecovery
                className="mt-1"
                message={milestoneError}
                messageTestId="milestone-error"
                testId="milestone-sign-recovery"
              />
            ) : null}
          </div>
        </div>
      </details>
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
          // Merge through `toInput`: the mint link and the one-click deploy
          // both republish the record, and `useCreateLaunch` publishes exactly
          // what it is given — a bare input would drop `tokenPlan`/`vesting`
          // (the same save bug the "editing the terms keeps the token plan"
          // e2e guards) and the Mint panel is gated on `tokenPlan`.
          onLink={(input) => handleSave(toInput(input))}
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
                  // A relaunch is a NEW auction: the old window belongs to the
                  // dead deployment, so it is dropped rather than inherited.
                  startBlock: undefined,
                  endBlock: undefined,
                  claimBlock: undefined,
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
