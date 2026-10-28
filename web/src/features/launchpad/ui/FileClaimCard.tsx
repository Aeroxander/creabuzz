import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  CREATE_ACCOUNT,
  SIGN_UP_EVENT,
} from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";

import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { isContributorProject } from "../lib/funding";
import { Input } from "@/shared/ui/input";
import { ethCall, getRpcEndpoint } from "../chain";
import { formatUnits, parseUnits } from "../lib/dao-actions";
import { evidenceProblem, evidenceUpdateContent } from "../lib/evidence";
import { encodeErc20Approve } from "../lib/evmCalls";
import {
  encodeSetCheck,
  encodeSubmitPaidClaim,
  hashText,
  idWord,
  ZERO_WORD,
} from "../lib/work";
import type { MandateView } from "../lib/work-read";
import {
  type OpenWorkArea,
  wordsAfterMove,
  wordsProblem,
} from "../lib/ways-to-help";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";

const sameAddress = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Ask to be recognised for work: name the claim, say where the work is, and state how it should be judged. Two steps
 * go to the wallet (file the claim, then state its check), and the second is retried alone if it fails: the claim
 * already exists by then, and pressing the button again only finishes it.
 *
 * A claim may also ask to be paid, from a work budget that holds money, and may put up a deposit that comes back with
 * the payout (and is lost if the reviewers object); a deposit needs the contributor's approval of the currency first,
 * which is one more step to the wallet.
 */
export function FileClaimCard({
  launch,
  mandates,
  wallet,
  gate,
  busy,
  onSend,
  areas = [],
  picked = null,
}: {
  /** The launch the evidence is published to, so reviewers can read what was submitted. */
  launch: Launch;
  /** The work areas open for submissions, each with its words when they are published (`lib/ways-to-help.ts`). */
  areas?: readonly OpenWorkArea[];
  /** A work area someone chose under Ways to help: the form opens on it, its words filled in. `at` makes a repeat count. */
  picked?: { area: OpenWorkArea; at: number } | null;
  mandates: MandateView[];
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  /** Sends one transaction; resolves true once it landed. */
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  // Ordinary work budgets only: a team's milestones are submitted from the milestone card, with the milestone chosen.
  const open = mandates.filter((m) => !m.closed && !m.isMilestonePanel);
  const publish = usePublishMirror();
  const [which, setWhich] = useState(0);
  const [name, setName] = useState("");
  const [evidence, setEvidence] = useState("");
  const [check, setCheck] = useState("");
  const [pay, setPay] = useState("");
  const [deposit, setDeposit] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const [areaId, setAreaId] = useState("");
  // Closed until someone asks for it (here, or by picking an area under Open work): an empty form makes the page long.
  const [opened, setOpened] = useState(false);
  // On the next frame, which a busy or slow device can deliver late: by then someone may already be typing in another
  // field, and moving the caret would send the rest of what they type into the name.
  const focusName = () =>
    requestAnimationFrame(() => {
      if (document.activeElement?.matches("input, textarea, select")) return;
      card.current?.scrollIntoView({ block: "start" });
      nameInput.current?.focus({ preventScroll: true });
    });
  const mandate = open[Math.min(which, open.length - 1)];
  const card = useRef<HTMLDivElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  // This budget's open work areas, and the one chosen, whose verified words fill the check.
  const budgetAreas = areas.filter(
    (a) => mandate && a.mandate === mandate.address.toLowerCase(),
  );
  const chosenArea = budgetAreas.find((a) => a.id === areaId) ?? null;
  // What was typed as the words for each work area, so moving between areas never carries one area's words into
  // another: an area's own published words win, then what was typed for it, else nothing.
  const typedFor = useRef(new Map<string, string>());
  const moveTo = (area: OpenWorkArea | null) => {
    setCheck(wordsAfterMove(typedFor.current, chosenArea, check, area));
    setAreaId(area?.id ?? "");
  };
  // Chosen under Ways to help: move to its budget and work area, fill its words, and bring the form into view. It
  // answers the pick only: the budgets are read again on every render, and a re-read must not undo what was typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per pick
  useEffect(() => {
    if (!picked) return;
    const index = open.findIndex(
      (m) => m.address.toLowerCase() === picked.area.mandate,
    );
    if (index >= 0) setWhich(index);
    moveTo(picked.area);
    setOpened(true);
    focusName();
  }, [picked]);
  // What the wallet holds of the budget's currency, to check a deposit against before the wallet is asked.
  const held = useQuery({
    queryKey: [
      "launchpad",
      "work",
      "claim-balance",
      wallet,
      mandate?.created.currency,
    ],
    enabled: Boolean(wallet && mandate && mandate.created.budget > 0n),
    queryFn: async () =>
      BigInt(
        await ethCall(
          getRpcEndpoint(),
          (mandate as NonNullable<typeof mandate>).created.currency,
          `0x70a08231${(wallet as string).slice(2).toLowerCase().padStart(64, "0")}`,
        ),
      ),
    staleTime: 5_000,
  });
  if (!mandate) return null;
  const holdsMoney = mandate.created.budget > 0n && mandate.currency !== null;

  const submit = async () => {
    setProblem(null);
    setFiled(null);
    if (!wallet) {
      setProblem("Connect your wallet to submit work.");
      return;
    }
    let id: string;
    try {
      id = idWord(name);
    } catch {
      setProblem("Give your work a short name, up to 32 characters.");
      return;
    }
    if (evidence.trim() === "" || check.trim() === "") {
      setProblem("Say where the work is, and how it should be judged.");
      return;
    }
    const tooLong = evidenceProblem(evidence);
    if (tooLong) {
      setProblem(tooLong);
      return;
    }
    // What it asks for, in the budget's currency: nothing unless the person filled it in. A currency that did not say how
    // many decimals it has cannot have an amount typed against it: a guessed scale would ask for the wrong sum.
    if (
      mandate.currency &&
      !mandate.currency.decimalsKnown &&
      (pay.trim() || deposit.trim())
    ) {
      setProblem(
        "This work budget's currency could not be read just now, so a payment or deposit cannot be typed in safely. Reload the page and try again, or ask to be recognised without payment.",
      );
      return;
    }
    const decimals = mandate.currency?.decimals ?? 0;
    let amount = 0n;
    let stake = 0n;
    try {
      if (pay.trim()) amount = parseUnits(pay, decimals, "pay", "The payment");
      if (deposit.trim())
        stake = parseUnits(deposit, decimals, "deposit", "The deposit");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Check the amounts.");
      return;
    }
    if ((amount > 0n || stake > 0n) && !holdsMoney) {
      setProblem(
        "This work budget has no money, so work here can only ask to be recognised.",
      );
      return;
    }
    if (stake > 0n && held.data !== undefined && stake > held.data) {
      setProblem(
        `Your deposit is ${formatUnits(stake, decimals)} ${mandate.currency?.symbol ?? ""}, but your wallet holds ${formatUnits(held.data, decimals)}.`,
      );
      return;
    }
    if (amount > 0n && amount > mandate.created.perProjectCap) {
      setProblem(
        `A single work area can hold at most ${formatUnits(mandate.created.perProjectCap, decimals)} of this budget.`,
      );
      return;
    }
    // The words must be the chosen work area's, read again now: words carried over from another area, or criteria
    // that changed since the page was opened, would make a submission its manager cannot accept.
    const wanted = hashText(check);
    const wrongWords = wordsProblem(chosenArea, check);
    if (wrongWords) {
      setProblem(wrongWords);
      return;
    }
    const existing = mandate.claims.find((c) => c.id === id);
    if (existing && !sameAddress(wallet, existing.record.contributor)) {
      setProblem("Someone else already used that name. Choose another.");
      return;
    }
    if (
      existing &&
      existing.record.checkHash !== ZERO_WORD &&
      existing.record.checkHash.toLowerCase() !== wanted &&
      (existing.project !== null ||
        existing.record.status !== "Open" ||
        existing.approvals + existing.objections > 0)
    ) {
      setProblem(
        "Your submission under that name was already accepted for review or reviewed, so its words can no longer change. Submit under a new name.",
      );
      return;
    }
    if (!existing) {
      if (stake > 0n) {
        // The deposit is pulled from the contributor's own balance, so the claims ledger must be allowed to take it.
        const approved = await onSend(
          `approve-${id}`,
          mandate.created.currency,
          encodeErc20Approve(mandate.claimsAddress, stake),
        );
        if (!approved) return;
      }
      const landed = await onSend(
        `file-${id}`,
        mandate.claimsAddress,
        encodeSubmitPaidClaim(id, amount, stake, hashText(evidence)),
      );
      if (!landed) return;
    }
    // State the words, or correct them: a claim no work area has accepted and nobody has reviewed can still change
    // its words (`ClaimStake.setCheck`), so a submission sent with the wrong words is put right, not stuck.
    if (!existing || existing.record.checkHash.toLowerCase() !== wanted) {
      const landed = await onSend(
        `check-${id}`,
        mandate.claimsAddress,
        encodeSetCheck(id, wanted),
      );
      if (!landed) return;
    }
    // The text itself, signed, so reviewers can read what the claim committed to. A claim without it cannot be approved,
    // so a failure here is said plainly and retried by pressing the button again (the steps above are skipped).
    try {
      await publish.mutateAsync({
        kind: KIND_LAUNCH_UPDATE,
        author: launch.record.author,
        launchId: launch.record.id,
        content: evidenceUpdateContent({
          name: name.trim(),
          claimId: id,
          mandate: mandate.address,
          evidence,
          check,
        }),
      });
    } catch {
      setProblem(
        "Your work is submitted, but its evidence could not be published, and reviewers cannot approve what they cannot read. Press Submit work again to publish it.",
      );
      return;
    }
    setFiled(name.trim());
    setName("");
    setEvidence("");
    setCheck("");
    setAreaId("");
    setPay("");
    setDeposit("");
  };

  // Someone without an account cannot submit anything: the form would only fail at the end.
  if (existingUserPubkey() === null) {
    return (
      <Card className="p-4" data-testid="work-file-claim-signup" ref={card}>
        <h3 className="text-sm font-semibold">Submit your work</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Create an account to submit work.
        </p>
        <Button
          className="mt-2"
          onClick={() => window.dispatchEvent(new Event(SIGN_UP_EVENT))}
          size="sm"
          type="button"
        >
          {CREATE_ACCOUNT}
        </Button>
      </Card>
    );
  }

  if (!opened) {
    return (
      <Card
        className="flex flex-wrap items-center justify-between gap-3 p-4"
        data-testid="work-file-claim"
        ref={card}
      >
        <div>
          <h3 className="text-sm font-semibold">Submit your work</h3>
          <p className="text-sm text-muted-foreground">
            Press Submit work on an open area above, or open the form here.
          </p>
        </div>
        <Button
          data-testid="work-file-open"
          onClick={() => {
            setOpened(true);
            focusName();
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Open the form
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-4" data-testid="work-file-claim" ref={card}>
      <h3 className="text-sm font-semibold">Submit your work</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {/* A contributor project shows how work is reviewed and awarded above, as three steps. */}
        {isContributorProject(launch.record)
          ? "Submit what you finished."
          : "Submit what you finished. The work area's manager accepts it for review, the reviewers check it, and then the project votes on an award."}
        {holdsMoney
          ? " Money is paid after a waiting period, to the wallet you submit from."
          : ""}
      </p>
      {holdsMoney && wallet ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="work-filing-wallet"
        >
          Payment will go to <code className="break-all">{wallet}</code>. File
          from the wallet you want to receive the funds.
        </p>
      ) : null}
      {open.length > 1 ? (
        <label className="mt-2 flex flex-col gap-1 text-sm">
          <span className="font-medium">Work budget</span>
          <select
            className="rounded-md border border-black/10 bg-transparent px-2 py-1 dark:border-white/10"
            onChange={(e) => {
              // Another budget: the chosen area's words do not come along.
              if (chosenArea) {
                wordsAfterMove(typedFor.current, chosenArea, check, null);
                setCheck("");
              }
              setWhich(Number(e.target.value));
              setAreaId("");
            }}
            value={which}
          >
            {open.map((m, i) => (
              <option key={m.address} value={i}>
                {m.isMilestonePanel
                  ? "The milestone panel (for your team's milestones)"
                  : `${m.address.slice(0, 10)}…`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="mt-2 grid gap-2">
        {budgetAreas.length > 0 ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Work area</span>
            <select
              className="rounded-md border border-black/10 bg-transparent px-2 py-1 dark:border-white/10"
              data-testid="work-claim-area"
              onChange={(e) =>
                moveTo(budgetAreas.find((a) => a.id === e.target.value) ?? null)
              }
              value={areaId}
            >
              <option value="">Not sure yet</option>
              {budgetAreas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-name-input">
            Name your work
          </label>
          <Input
            data-testid="work-claim-name"
            id="work-claim-name-input"
            ref={nameInput}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            placeholder="write-the-docs"
            value={name}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-evidence-input">
            Where the work is
          </label>
          <Input
            data-testid="work-claim-evidence"
            id="work-claim-evidence-input"
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="A link, or a short description"
            value={evidence}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-check-input">
            How it should be judged
          </label>
          <Input
            data-testid="work-claim-check"
            id="work-claim-check-input"
            onChange={(e) => setCheck(e.target.value)}
            placeholder="The work area's acceptance check, in its exact words"
            value={check}
          />
          <span
            className="text-xs text-muted-foreground"
            data-testid="work-claim-check-note"
          >
            {chosenArea?.words && check.trim() === chosenArea.words
              ? `These are the words ${chosenArea.name} was set up with.`
              : chosenArea && !chosenArea.words
                ? `${chosenArea.name}'s words are not published here: ask its manager for them. If yours differ, it cannot be accepted for review.`
                : "Use the work area's exact words. If they differ, its manager cannot accept your work for review."}
          </span>
        </div>
      </div>
      {holdsMoney ? (
        <details className="mt-2 text-sm" data-testid="work-claim-pay-section">
          <summary className="cursor-pointer font-medium">
            Ask to be paid too
          </summary>
          <div className="mt-2 grid gap-2">
            <div className="flex flex-col gap-1">
              <label className="font-medium" htmlFor="work-claim-pay-input">
                Payment you ask for ({mandate.currency?.symbol})
              </label>
              <Input
                data-testid="work-claim-pay"
                id="work-claim-pay-input"
                inputMode="decimal"
                onChange={(e) => setPay(e.target.value)}
                placeholder="0"
                value={pay}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-medium" htmlFor="work-claim-deposit-input">
                Deposit you put up ({mandate.currency?.symbol}, optional)
              </label>
              <Input
                data-testid="work-claim-deposit"
                id="work-claim-deposit-input"
                inputMode="decimal"
                onChange={(e) => setDeposit(e.target.value)}
                placeholder="0"
                value={deposit}
              />
              <span className="text-xs text-muted-foreground">
                A deposit shows you stand behind the work. You get it back with
                your payment; it is lost if the reviewers object.
              </span>
            </div>
          </div>
        </details>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          data-testid="work-claim-submit"
          disabled={busy !== null || gate !== null}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          Submit work
        </Button>
        {filed ? (
          <span
            className="text-sm"
            data-testid="work-claim-filed"
            role="status"
          >
            Submitted “{filed}”. It is waiting for a work area&apos;s manager to
            accept it for review.
          </span>
        ) : null}
      </div>
      {problem ? (
        <p
          className="mt-2 text-sm text-red-700 dark:text-red-300"
          data-testid="work-claim-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </Card>
  );
}
