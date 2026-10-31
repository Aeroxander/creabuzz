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
import { formatUnits, parseUnits } from "@creaton/core/launchpad/daoActions.ts";
import { WorkCheckAi } from "./WorkCheckAi";
import {
  evidenceProblem,
  evidenceUpdateContent,
  withSelfCheck,
} from "../lib/evidence";
import { encodeErc20Approve } from "@creaton/core/launchpad/evmCalls.ts";
import {
  encodeSetCheck,
  encodeSubmitPaidClaim,
  hashText,
  idWord,
  ZERO_WORD,
} from "@creaton/core/launchpad/work.ts";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import {
  type OpenWorkArea,
  wordsAfterMove,
  wordsProblem,
} from "../lib/ways-to-help";
import type { Launch } from "../models";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { usePublishMirror } from "../use-launches";
import {
  nameProblem,
  noAreaProblem,
  resubmitProblem,
} from "../lib/claim-file-checks";

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
  onSendBatch,
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
  /** Sends the calls in order as one step (one passkey prompt, or one wallet prompt each); resolves true once they landed. */
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
}) {
  // Ordinary work budgets only: a team's milestones are submitted from the milestone card, with the milestone chosen.
  const open = mandates.filter((m) => !m.closed && !m.isMilestonePanel);
  const publish = usePublishMirror();
  const [which, setWhich] = useState(0);
  const [name, setName] = useState("");
  const [evidence, setEvidence] = useState("");
  // How the submitter checked the work against its "done when" (CHECK-AND-NEWCOMER-PLAN.md): added to the evidence, so
  // reviewers read it and the claim commits to it.
  const [met, setMet] = useState("");
  const [notMet, setNotMet] = useState("");
  const submitted = withSelfCheck(evidence, { met, notMet });
  const [check, setCheck] = useState("");
  const [pay, setPay] = useState("");
  const [deposit, setDeposit] = useState("");
  const [problem, setProblemText] = useState<string | null>(null);
  // The field a problem is about: it is marked, the problem is said under it, and it is brought into view.
  const [problemField, setProblemField] = useState<ProblemField | null>(null);
  const setProblem = (
    text: string | null,
    field: ProblemField | null = null,
  ) => {
    setProblemText(text);
    setProblemField(text ? field : null);
    if (text && field)
      requestAnimationFrame(() => {
        const element = card.current?.querySelector<HTMLElement>(
          `[data-field="${field}"]`,
        );
        element?.scrollIntoView({ block: "center" });
        element?.focus({ preventScroll: true });
      });
  };
  // A work area's published words are shown as they are; changing them is a deliberate step.
  const [ownWords, setOwnWords] = useState(false);
  const [filed, setFiled] = useState<{
    name: string;
    /** It was already accepted for review: it waits for the reviewers, not a manager. */
    accepted: boolean;
  } | null>(null);
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
    setOwnWords(false);
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
  // The chosen area's published words, untouched: shown read-only unless the person asks to change them.
  const lockedWords = Boolean(
    chosenArea?.words && !ownWords && check.trim() === chosenArea.words,
  );
  const fieldProblem = (field: ProblemField) =>
    problemField === field ? problem : null;
  const invalid = (field: ProblemField) => ({
    "data-field": field,
    "aria-invalid": problemField === field ? (true as const) : undefined,
    "aria-describedby":
      [
        problemField === field ? `work-claim-${field}-problem` : null,
        field === "name" ? "work-claim-name-hint" : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  });
  const holdsMoney = mandate.created.budget > 0n && mandate.currency !== null;

  const submit = async () => {
    setProblem(null);
    setFiled(null);
    if (!wallet) {
      setProblem("Connect your wallet to submit work.");
      return;
    }
    let id: string;
    const badName = nameProblem(name);
    if (badName) {
      setProblem(badName, "name");
      return;
    }
    try {
      id = idWord(name);
    } catch {
      setProblem("Give your work a title, up to 32 characters.", "name");
      return;
    }
    if (evidence.trim() === "") {
      setProblem(
        "Say where the work is, and how it should be judged.",
        "evidence",
      );
      return;
    }
    // "Not sure yet" where there are work areas: only a work area's words can be accepted, so pick one first.
    if (!chosenArea && budgetAreas.length > 0 && check.trim() === "") {
      setProblem("Pick the work area this work is for.", "area");
      return;
    }
    if (check.trim() === "") {
      setProblem(
        "Say where the work is, and how it should be judged.",
        "check",
      );
      return;
    }
    if (met.trim() === "") {
      setProblem(
        "Say how your work meets the work area's words: what you ran, checked or compared.",
        "met",
      );
      return;
    }
    const tooLong = evidenceProblem(submitted);
    if (tooLong) {
      setProblem(tooLong, "evidence");
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
      setProblem(wrongWords, "check");
      return;
    }
    // "Not sure yet" with words of one's own: only a work area's words can ever be accepted for review.
    const noArea = chosenArea ? null : noAreaProblem(budgetAreas, check);
    if (noArea) {
      setProblem(noArea, "area");
      return;
    }
    const existing = mandate.claims.find((c) => c.id === id);
    if (existing && !sameAddress(wallet, existing.record.contributor)) {
      setProblem(
        "Someone else already used that name. Choose another.",
        "name",
      );
      return;
    }
    // The same name again: only to finish a submission still open with this very evidence. Anything else would send
    // nothing while saying it was submitted.
    const reused = resubmitProblem(existing, submitted);
    if (reused) {
      setProblem(reused, "name");
      return;
    }
    if (
      existing &&
      existing.record.checkHash !== ZERO_WORD &&
      existing.record.checkHash.toLowerCase() !== wanted &&
      (existing.project !== null ||
        existing.record.status !== "Open" ||
        existing.approvals +
          existing.objections +
          (existing.earlyVerdicts ?? 0) >
          0)
    ) {
      setProblem(
        "Your submission under that name was already accepted for review or reviewed, so its words can no longer change. Submit under a new name.",
      );
      return;
    }
    // Everything still to send, as one step: with a passkey account one prompt for all of it, with a wallet one prompt
    // each, in this order, stopping at the first that fails (pressing the button again picks up from there).
    const calls: SenderCall[] = [];
    if (!existing) {
      if (stake > 0n) {
        // The deposit is pulled from the contributor's own balance, so the claims ledger must be allowed to take it.
        calls.push({
          to: mandate.created.currency,
          data: encodeErc20Approve(mandate.claimsAddress, stake),
        });
      }
      calls.push({
        to: mandate.claimsAddress,
        data: encodeSubmitPaidClaim(id, amount, stake, hashText(submitted)),
      });
    }
    // State the words, or correct them: a claim no work area has accepted and nobody has reviewed can still change
    // its words (`ClaimStake.setCheck`), so a submission sent with the wrong words is put right, not stuck.
    if (!existing || existing.record.checkHash.toLowerCase() !== wanted) {
      calls.push({
        to: mandate.claimsAddress,
        data: encodeSetCheck(id, wanted),
      });
    }
    if (calls.length !== 0 && !(await onSendBatch(`file-${id}`, calls))) {
      return;
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
          evidence: submitted,
          check,
        }),
      });
    } catch {
      setProblem(
        "Your work is submitted, but its evidence could not be published, and reviewers cannot approve what they cannot read. Press Submit work again to publish it.",
      );
      return;
    }
    setFiled({
      name: name.trim(),
      accepted: existing !== undefined && existing.project !== null,
    });
    setName("");
    setEvidence("");
    setMet("");
    setNotMet("");
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
          ? " Money is paid after a waiting period, to the account you submit from."
          : ""}
      </p>
      {holdsMoney && wallet ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="work-filing-wallet"
        >
          Payment will go to <code className="break-all">{wallet}</code>, the
          account you submit from.
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
                  : `Work budget ${i + 1}`}
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
              {...invalid("area")}
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
                  {a.title}
                </option>
              ))}
            </select>
            <FieldProblem field="area" problem={fieldProblem("area")} />
          </label>
        ) : null}
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-name-input">
            Title
          </label>
          <Input
            {...invalid("name")}
            data-testid="work-claim-name"
            id="work-claim-name-input"
            ref={nameInput}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. First draft of the guide"
            value={name}
          />
          <FieldProblem field="name" problem={fieldProblem("name")} />
          <span
            className="text-xs text-muted-foreground"
            id="work-claim-name-hint"
          >
            Up to 32 characters, without accents. Fixed work gets a new title.
          </span>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-evidence-input">
            Where the work is
          </label>
          <Input
            {...invalid("evidence")}
            data-testid="work-claim-evidence"
            id="work-claim-evidence-input"
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="A link, or a short description"
            value={evidence}
          />
          <FieldProblem field="evidence" problem={fieldProblem("evidence")} />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-check-input">
            How it should be judged
          </label>
          {/* A work area's published words are shown whole and read-only (a one-line box cut them off on a phone);
              typing other words is a deliberate step, since any change means it cannot be accepted for review. */}
          <textarea
            {...invalid("check")}
            className={`rounded-md border border-input px-3 py-2 text-sm [field-sizing:content] placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${lockedWords ? "bg-secondary/50" : "bg-transparent"}`}
            data-testid="work-claim-check"
            id="work-claim-check-input"
            onChange={(e) => setCheck(e.target.value)}
            placeholder={
              !chosenArea && budgetAreas.length > 0
                ? "Pick the work area above and its words are filled in"
                : "The work area's acceptance check, in its exact words"
            }
            readOnly={lockedWords}
            // Published words are shown whole: the box grows with them instead of cutting them off on a phone.
            rows={
              lockedWords
                ? Math.min(12, Math.max(2, Math.ceil(check.length / 36)))
                : 2
            }
            value={check}
          />
          <FieldProblem field="check" problem={fieldProblem("check")} />
          <span
            className="text-xs text-muted-foreground"
            data-testid="work-claim-check-note"
          >
            {lockedWords && chosenArea
              ? `These are the words ${chosenArea.title} was set up with. `
              : chosenArea?.words && check.trim() === chosenArea.words
                ? `These are the words ${chosenArea.title} was set up with.`
                : chosenArea && !chosenArea.words
                  ? `${chosenArea.title}'s words are not published here: ask its manager for them. If yours differ, it cannot be accepted for review.`
                  : "Use the work area's exact words. If they differ, its manager cannot accept your work for review."}
            {lockedWords ? (
              <button
                className="underline"
                data-testid="work-claim-own-words"
                onClick={() => {
                  setOwnWords(true);
                  // This button goes away once the words can be changed: keep focus in the box being unlocked.
                  requestAnimationFrame(() => {
                    const box =
                      card.current?.querySelector<HTMLTextAreaElement>(
                        '[data-field="check"]',
                      );
                    box?.focus();
                    box?.setSelectionRange(box.value.length, box.value.length);
                  });
                }}
                type="button"
              >
                Use different words
              </button>
            ) : null}
          </span>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-met-input">
            How you checked it against those words
          </label>
          <Input
            {...invalid("met")}
            data-testid="work-claim-met"
            id="work-claim-met-input"
            onChange={(e) => setMet(e.target.value)}
            placeholder="What you ran, opened or compared, and what you saw"
            value={met}
          />
          <FieldProblem field="met" problem={fieldProblem("met")} />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-not-met-input">
            Anything it does not meet yet (optional)
          </label>
          <Input
            data-testid="work-claim-not-met"
            id="work-claim-not-met-input"
            onChange={(e) => setNotMet(e.target.value)}
            placeholder="Saying it now is better than a turn-down later"
            value={notMet}
          />
          <span className="text-xs text-muted-foreground">
            Both are added to your evidence, so reviewers read them.
          </span>
          <WorkCheckAi
            doneWhen={check}
            evidence={evidence}
            met={met}
            notMet={notMet}
          />
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
            {filed.accepted
              ? `Submitted “${filed.name}”. It is waiting for the reviewers.`
              : `Submitted “${filed.name}”. It is waiting for the work area's manager to accept it for review.`}
          </span>
        ) : null}
      </div>
      {/* A problem about one field is said under that field only; the rest are said here. */}
      {problem && problemField === null ? (
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

type ProblemField = "area" | "name" | "evidence" | "check" | "met";

/** A problem said under the field it is about (the field's `aria-describedby` names it). */
function FieldProblem({
  field,
  problem,
}: {
  field: ProblemField;
  problem: string | null;
}) {
  return problem ? (
    <span
      className="text-xs text-destructive"
      data-testid="work-claim-problem"
      id={`work-claim-${field}-problem`}
      role="alert"
    >
      {problem}
    </span>
  ) : null;
}
