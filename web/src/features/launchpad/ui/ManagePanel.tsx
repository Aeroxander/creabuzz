import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { hasFounderCommitments } from "../models";
import { toAtomic } from "../lib/amounts";
import { hasBlockingIssue, validateLaunchParams } from "../lib/launch-params";
import {
  EVIDENCE_HASH_RE,
  TX_HASH_HINT,
  claimReceiptParts,
  isTxHash,
  verdictReceiptParts,
} from "../lib/milestone-receipt";

import {
  useCreateLaunch,
  useLaunch,
  usePublishMirror,
  type CreateLaunchInput,
} from "../use-launches";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { CreateLaunchDialog } from "./CreateLaunchDialog";

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
  planClaimAction,
  planClaimSubmit,
  planVerdictSubmit,
} from "../lib/claim-submit";
import { AuctionSection } from "./AuctionSection";
import { recordToInput } from "../lib/record-input";
import { TokenMintPanel } from "./TokenMintPanel";
import { TrustGraphCuratorPanel } from "./TrustGraphCuratorPanel";

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
  /** What the last completed milestone step did — the machine's status leg. */
  const [milestoneStatus, setMilestoneStatus] = useState<string | null>(null);
  /** Destructive stage change: confirmed inline, like the delete below. */
  const [confirmRegress, setConfirmRegress] = useState<"failed" | null>(null);
  /** Open the editor seeded for a relaunch (fresh stage, cleared chain links). */
  const [relaunchSeed, setRelaunchSeed] = useState(false);
  if (!launch) return null;
  const { record } = launch;

  const toInput = (overrides: Partial<CreateLaunchInput> = {}) =>
    recordToInput(record, overrides);

  /**
   * Relaunch a failed launch: republish the SAME record id (`d`) with a fresh
   * stage and cleared chain links. The community and discussion history keep
   * their identity; the new auction is a new deploy.
   */
  const recordClaim = async () => {
    setMilestoneError(null);
    setMilestoneStatus(null);
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
      setMilestoneStatus("Claim mirror recorded.");
    } catch (err) {
      setMilestoneError(
        err instanceof Error ? err.message : "Failed to record the claim.",
      );
    }
  };

  const recordVerdict = async (approve: boolean) => {
    setMilestoneError(null);
    setMilestoneStatus(null);
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
      setMilestoneStatus(
        approve ? "Verdict recorded: approve." : "Verdict recorded: reject.",
      );
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
    kind:
      | "claim"
      | "fund"
      | "verdict-approve"
      | "verdict-reject"
      | "settle"
      | "payout",
  ) => {
    setMilestoneError(null);
    setMilestoneStatus(null);
    setOnchainSending(true);
    try {
      let calls: OnchainCall[] | null = null;
      if (kind === "claim" || kind === "fund") {
        const row = record.unlocks?.milestones.find(
          (m) => m.claim === claimId.trim(),
        );
        const plan = row
          ? planClaimSubmit({
              record,
              row,
              evidenceHash: evidenceHash.trim(),
            })
          : null;
        calls =
          kind === "claim"
            ? plan
              ? [plan.call]
              : null
            : (plan?.fundCalls ?? null);
      } else if (kind === "settle" || kind === "payout") {
        const call = planClaimAction(record, claimId.trim(), kind);
        calls = call ? [call] : null;
      } else {
        const call = planVerdictSubmit(
          record,
          claimId.trim(),
          kind === "verdict-approve",
        );
        calls = call ? [call] : null;
      }
      if (!calls) {
        setMilestoneError(
          kind === "fund" && record.claimStake && !record.token
            ? "Link the token address on this launch before reserving a payout."
            : "This launch isn't set up for onchain milestones yet. Link its milestone contracts on the launch record first.",
        );
        return;
      }
      const sender = resolveSender(milestoneSender);
      const result = await sender.sendCalls(calls);
      if (!isTxHash(result.txHash)) {
        throw new Error("The sender returned an invalid hash.");
      }
      setTxHash(result.txHash); // prefill for the receipt
      setMilestoneStatus("Onchain step sent — the hash above is filled in.");
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
            <p className="mt-2 text-xs text-black/60 dark:text-white/60">
              After the claim is submitted, the treasury reserves its payout.
              Once enough verifiers attest, anyone can settle it, and the
              contributor then collects the payout.
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                data-testid="fund-claim-onchain"
                disabled={
                  onchainSending ||
                  claimId.trim() === "" ||
                  !EVIDENCE_HASH_RE.test(evidenceHash.trim())
                }
                onClick={() => void submitOnchain("fund")}
                size="sm"
                type="button"
                variant="outline"
              >
                Reserve payout
              </Button>
              <Button
                data-testid="settle-claim-onchain"
                disabled={onchainSending || claimId.trim() === ""}
                onClick={() => void submitOnchain("settle")}
                size="sm"
                type="button"
                variant="outline"
              >
                Settle
              </Button>
              <Button
                data-testid="payout-claim-onchain"
                disabled={onchainSending || claimId.trim() === ""}
                onClick={() => void submitOnchain("payout")}
                size="sm"
                type="button"
                variant="outline"
              >
                Collect payout
              </Button>
            </div>
            {milestoneStatus ? (
              <p
                className="mt-1 text-sm text-emerald-700 dark:text-emerald-400"
                role="status"
              >
                <span data-testid="milestone-status">{milestoneStatus}</span>
              </p>
            ) : null}
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

      <TrustGraphCuratorPanel />
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

      <AuctionSection
        launch={launch}
        // The deploy flow reports a failed record write and offers a retry, so
        // this must PROPAGATE the publish error (not `handleSave`, which toasts
        // and swallows it). `toInput` keeps every field the record holds.
        onLink={(input) => save.mutateAsync(toInput(input))}
      />

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
