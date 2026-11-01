import { type ChallengeIntent, challengePickKey } from "../lib/challenge";
import type { SponsorIntent } from "../lib/sponsor";
import { raisesOffered } from "../lib/raises-offered";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DecisionDraft } from "@creaton/core/launchpad/daoActions.ts";
import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import type { DecisionsSnapshot } from "@creaton/core/launchpad/decisions.ts";
import { encodeOpenProposalWithAction } from "../lib/vote-tx";
import type { PendingWords } from "../lib/pending-words";
import type { Launch } from "../models";
import { usePendingWords } from "../use-pending-words";
import { PendingWordsNote } from "./PendingWordsNote";
import {
  AwardForm,
  type FormContext,
  PayForm,
  ProjectForm,
} from "./decision-forms";
import {
  CloseBudgetForm,
  FreezeForm,
  SlashForm,
  UnwindForm,
} from "./enforcement-forms";
import { TradingForm } from "./TradingForm";
import { WorkBudgetForm } from "./WorkBudgetForm";
import { isContributorProject } from "../lib/funding";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";
import { erc20BalanceOf, ethCall, getRpcEndpoint } from "../chain";
import {
  type ChallengeAnswers,
  type ChallengeExtras,
  challengeAnswered,
  challengeContent,
  challengeProblem,
  EMPTY_CHALLENGE,
  KIND_CHALLENGE,
  NO_EXTRAS,
} from "@creaton/core/launchpad/challenge.ts";
import { proposalIdCall } from "@creaton/core/launchpad/decisions.ts";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { launchCoordinate } from "../models";
import { useReasonShown } from "../use-review-reasons";
import { ChallengeQuestions } from "./ChallengeQuestions";
import {
  localUsdcAddress,
  payoutsFactory,
  weeklyRounds,
} from "../chain-config";
import { PayoutsForm } from "./PayoutsForm";
import { FundingDecisionForm } from "./FundingDecisionForm";
import { RoundsDecisionForm } from "./RoundsDecisionForm";
import {
  cannotOpenDecision,
  cannotOpenLine,
  whoMayOpen,
} from "../lib/proposal-gate";

type Kind =
  | "budget"
  | "project"
  | "award"
  | "pay"
  | "freeze"
  | "unwind"
  | "slash"
  | "close"
  | "trading"
  | "rounds"
  | "funding"
  | "payouts";

/** The decisions whose forms pick from the DAO's work budgets and claims. */
const WORK_KINDS: ReadonlySet<Kind> = new Set([
  "project",
  "award",
  "freeze",
  "unwind",
  "slash",
  "close",
]);

const KINDS: { id: Kind; label: string; about: string }[] = [
  {
    id: "budget",
    label: "Set aside a work budget",
    about: "Shares (and optionally money) for people to earn by doing work.",
  },
  {
    id: "project",
    label: "Approve a work area",
    about:
      "A work area inside a work budget, with a manager and a way to judge the work.",
  },
  {
    id: "award",
    label: "Award Shares for submitted work",
    about: "Give Shares for work the reviewers approved.",
  },
  {
    id: "freeze",
    label: "Freeze a submission",
    about:
      "Hold back work you doubt. Nothing is paid or awarded for it while it is frozen, and a later vote can reject it.",
  },
  {
    id: "unwind",
    label: "Reject a frozen submission",
    about:
      "End it for good. The money reserved for it goes back to the budget.",
  },
  {
    id: "slash",
    label: "Take a reviewer's bond",
    about: "After an approval you dispute. It is paid to the DAO.",
  },
  {
    id: "close",
    label: "Close a work budget",
    about: "Stop new submissions and take back what is not set aside.",
  },
  {
    id: "trading",
    label: "Open trading",
    about:
      "Let Shares be sent between wallets, and so bought and sold. It can open only 30 days after a vote announces it.",
  },
  {
    id: "rounds",
    label: "Weekly rounds",
    about:
      "Once a week, match members who want out with people who want in, at one price never below what leaving pays, or turn that off. It can start only 30 days after the vote.",
  },
  {
    id: "funding",
    label: "Sell new units for the project",
    about:
      "Publish funding terms (what buyers get, and the most the project can ever sell), or open a sale within them. Nothing sells until 30 days after terms are published.",
  },
  {
    id: "payouts",
    label: "Pay holders",
    about:
      "Share revenue with everyone holding Shares or Loot, or pay them from the treasury.",
  },
  {
    id: "pay",
    label: "Pay from the treasury",
    about:
      "Send some of the treasury's money to someone. No reviewer checks it.",
  },
];

/** The kinds of vote that commit money or Shares, for which the challenge is asked. */
const MONEY_KINDS: ReadonlySet<Kind> = new Set([
  "budget",
  "project",
  "award",
  "pay",
]);

function nonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Put a new decision to a vote. Pick what kind, fill in the details, read exactly what would happen in plain words, and
 * open it. Opening needs a minimum of voting Shares (the DAO's setting), and a wallet below it is told so before it tries.
 */
export function DecisionComposer({
  snapshot,
  ctx,
  busy,
  gate,
  onSend,
  challenge,
  sponsor,
  launch,
}: {
  /** The project the decisions are for: a new work area's words are published to it beside the vote. */
  launch?: Launch;
  snapshot: DecisionsSnapshot;
  ctx: FormContext;
  busy: string | null;
  gate: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
  /** Someone came from a claim card to doubt it: open with that form and that claim chosen. */
  challenge?: ChallengeIntent | null;
  /** Someone is putting a suggestion to a vote (D84): open "Approve a work area" filled in from it. */
  sponsor?: SponsorIntent | null;
}) {
  const [open, setOpen] = useState(Boolean(challenge || sponsor));
  const [kind, setKind] = useState<Kind>(
    challenge?.kind ?? (sponsor ? "project" : "budget"),
  );
  const [done, setDone] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  // A contributor project sold nothing, so its money decisions are offered for what its DAO actually has (D111): undoing
  // a freeze always (the way back from one), taking a bond where a budget asks bonds, paying where the DAO holds USDC.
  const contributor = launch ? isContributorProject(launch.record) : false;
  const usdc = contributor
    ? usdcAddress(ctx.chainId ?? null, localUsdcAddress())
    : null;
  const usdcHeld = useQuery({
    queryKey: ["launchpad", "contributor-funds", ctx.dao, usdc ?? "none"],
    enabled: usdc !== null,
    queryFn: () => erc20BalanceOf(getRpcEndpoint(), usdc as string, ctx.dao),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const offered = (id: Kind): boolean => {
    // Opening trading makes Shares something to buy and sell: a contributor-only build offers no sale of any kind.
    if (id === "trading" && !raisesOffered()) return false;
    if (id === "rounds")
      return weeklyRounds(ctx.chainId ?? null) !== null && contributor;
    // Selling new units is a raise, so a contributor-only build does not offer it either. Sales happen in weekly rounds,
    // and need the summoner's funding-terms contract.
    if (id === "funding" && !raisesOffered()) return false;
    if (id === "funding")
      return (
        weeklyRounds(ctx.chainId ?? null) !== null &&
        contributor &&
        Boolean(ctx.fundingTerms)
      );
    // Payouts count every holder from when they hold; locked team Shares are not handled, so contributor projects only.
    if (id === "payouts")
      return payoutsFactory(ctx.chainId ?? null) !== null && contributor;
    if (!contributor) return true;
    if (id === "slash")
      return (
        ctx.work?.mandates.some((m) => m.bond !== null || m.bondUnreadable) ??
        false
      );
    if (id === "pay") return usdc !== null && (usdcHeld.data ?? 0n) > 0n;
    return true;
  };
  // A contributor project's work is in Shares, so a payment is in the USDC its DAO holds.
  const payCtx: FormContext =
    contributor && usdc
      ? { ...ctx, currency: usdc, currencyDecimals: 6, currencySymbol: "USDC" }
      : ctx;

  const capacity = snapshot.walletCapacity;
  const blocked =
    capacity === null
      ? null
      : capacity < snapshot.proposalThreshold || capacity === 0n
        ? `You need at least ${formatUnits(snapshot.proposalThreshold, 18)} Shares to put a decision to a vote. You hold ${formatUnits(capacity, 18)}.`
        : null;

  // A work area's words the chain does not keep, published beside its vote. The job is kept in this browser before the
  // form lets go of it and dropped once the server accepts the words, so a failed publish survives a reload and is
  // retried on its own (`PendingWordsNote`). Held here only when the browser would not keep it.
  const pending = usePendingWords(launch);
  const [unkept, setUnkept] = useState<PendingWords | null>(null);
  const publishWords = async (area: NonNullable<DecisionDraft["workArea"]>) => {
    const { job, result } = pending.keep(area);
    try {
      await pending.send(job);
      setUnkept(null);
    } catch {
      if (result !== "kept") setUnkept(job);
    }
  };
  // The challenge (CHALLENGER-PLAN.md): for a vote that commits money or Shares, three questions against it, published
  // before the vote opens and naming it by the id the DAO will give it. A record nobody would be shown is not published.
  const challenged = launch !== undefined && MONEY_KINDS.has(kind);
  const [against, setAgainst] = useState<ChallengeAnswers>(EMPTY_CHALLENGE);
  // The AI's follow-ups and summary (step 2), when the server's AI service is on; the summary must be read first.
  const [extras, setExtras] = useState<ChallengeExtras>(NO_EXTRAS);
  const [summaryToRead, setSummaryToRead] = useState(false);
  const [againstFailure, setAgainstFailure] = useState<string | null>(null);
  const shown = useReasonShown(ctx.wallet ?? "");
  const queryClient = useQueryClient();
  const notShown =
    challenged && challengeAnswered(against) && shown.shown === false
      ? "This account isn't linked to the wallet that opens the vote, so holders would not see your answers. Link it under Payment wallet on your profile, or clear the answers to open the vote without them."
      : null;
  const publishChallenge = async (
    draft: DecisionDraft,
    voteNonce: string,
  ): Promise<boolean> => {
    if (!challenged || !launch || !challengeAnswered(against)) return true;
    if (summaryToRead) {
      setAgainstFailure(
        "Read the summary the AI drafted, then accept it or change it, before the vote opens.",
      );
      return false;
    }
    const problem = challengeProblem(against, extras);
    if (problem) {
      setAgainstFailure(problem);
      return false;
    }
    if (!ctx.wallet || (await shown.check()) !== true) {
      setAgainstFailure(
        "Holders would not see your answers from this account, so nothing was sent. Link it, or clear the answers.",
      );
      return false;
    }
    try {
      const reply = await ethCall(
        getRpcEndpoint(),
        snapshot.dao,
        proposalIdCall({
          op: 0,
          to: draft.to,
          value: 0n,
          data: draft.data,
          nonce: voteNonce,
        }),
      );
      await publishAsUser(
        {
          kind: KIND_CHALLENGE,
          tags: [
            ["a", launchCoordinate(launch.record.author, launch.record.id)],
          ],
          content: JSON.stringify(
            challengeContent({
              decision: reply.slice(0, 66),
              proposer: ctx.wallet,
              title: draft.title,
              answers: against,
              extras,
            }),
          ),
        },
        "The server did not take your answers.",
      );
      void queryClient.invalidateQueries({
        queryKey: [
          "launchpad",
          "challenges",
          launchCoordinate(launch.record.author, launch.record.id),
        ],
      });
      return true;
    } catch {
      setAgainstFailure(
        "Your answers could not be published, so the vote was not opened. Try again, or clear them to open it without.",
      );
      return false;
    }
  };
  const submit = async (draft: DecisionDraft) => {
    setDone(null);
    setAgainstFailure(null);
    const voteNonce = nonce();
    if (!(await publishChallenge(draft, voteNonce))) return;
    const landed = await onSend(
      "open-decision",
      snapshot.dao,
      encodeOpenProposalWithAction({
        op: 0,
        to: draft.to,
        value: 0n,
        data: draft.data,
        nonce: voteNonce,
      }),
    );
    if (landed) {
      setDone(draft.title);
      setAgainst(EMPTY_CHALLENGE);
      setExtras(NO_EXTRAS);
      setSummaryToRead(false);
      setFormKey((k) => k + 1);
      setOpen(false);
      // The chain keeps only the hash of a work area's words: publish the words, so people can see what to deliver.
      if (draft.workArea && launch) await publishWords(draft.workArea);
    }
  };

  return (
    <Card className="p-4" data-testid="decision-composer">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Put something to a vote</h3>
          {cannotOpenLine(snapshot) && !open ? (
            // Someone who cannot open one is told why, and where Shares come from, instead of a rule with nothing to do.
            <p
              className="text-xs text-muted-foreground"
              data-testid="decision-cannot-open"
            >
              {cannotOpenLine(snapshot)}{" "}
              {launch ? (
                <Link
                  className="font-medium text-primary-ink underline"
                  params={{ launchId: launch.record.id }}
                  search={{ author: launch.record.author, tab: "work" }}
                  to="/launchpad/$launchId"
                >
                  See open work
                </Link>
              ) : null}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {whoMayOpen(snapshot)} can open a decision.
            </p>
          )}
        </div>
        {/* Someone known to hold too few Shares is not offered a form they could never send (a vote they came to
            open from elsewhere still shows, with why it cannot be sent). */}
        {cannotOpenDecision(snapshot) && !open ? null : (
          <Button
            aria-expanded={open}
            data-testid="decision-new"
            onClick={() => setOpen((v) => !v)}
            size="sm"
            type="button"
            variant={open ? "outline" : "default"}
          >
            {open ? "Close" : "New decision"}
          </Button>
        )}
      </div>
      {done ? (
        <p className="mt-2 text-sm" data-testid="decision-opened" role="status">
          Opened “{done}” for voting. It is in the list below.
        </p>
      ) : null}
      {launch ? (
        <div className="mt-2">
          <PendingWordsNote launch={launch} />
        </div>
      ) : null}
      {unkept ? (
        <p
          className="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-300"
          data-testid="decision-words-unpublished"
          role="alert"
        >
          The vote is open, but the work area&apos;s words could not be
          published, and this browser could not keep them to try again later.
          Publish them before you leave this page:
          <Button
            disabled={pending.busy}
            onClick={async () => {
              try {
                await pending.send(unkept);
                setUnkept(null);
              } catch {
                // Still not taken: the note stays, with its button.
              }
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Publish them again
          </Button>
        </p>
      ) : null}
      {open ? (
        <div className="mt-3">
          {/* On a phone the cards would stack far above the form they open: one list instead, the form right under it. */}
          <label className="flex flex-col gap-1 text-sm sm:hidden">
            <span className="font-medium">What kind of decision</span>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
              data-testid="decision-kind-select"
              onChange={(event) => setKind(event.target.value as Kind)}
              value={kind}
            >
              {KINDS.filter((k) => offered(k.id)).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              {contributor && kind === "unwind"
                ? "End a frozen submission for good. Nothing is awarded for it."
                : KINDS.find((k) => k.id === kind)?.about}
            </span>
          </label>
          <fieldset className="hidden gap-2 sm:grid sm:grid-cols-3">
            <legend className="sr-only">What kind of decision</legend>
            {KINDS.filter((k) => offered(k.id)).map((k) => (
              <button
                aria-pressed={kind === k.id}
                className={`rounded-lg border p-3 text-left text-sm ${kind === k.id ? "border-primary bg-primary/5" : "border-black/10 dark:border-white/10"}`}
                data-testid={`decision-kind-${k.id}`}
                key={k.id}
                onClick={() => setKind(k.id)}
                type="button"
              >
                <span className="block font-medium">{k.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {contributor && k.id === "unwind"
                    ? "End a frozen submission for good. Nothing is awarded for it."
                    : k.about}
                </span>
              </button>
            ))}
          </fieldset>
          {challenged && launch ? (
            <ChallengeQuestions
              extras={extras}
              kindLabel={KINDS.find((k) => k.id === kind)?.label ?? kind}
              launch={launch}
              notShown={notShown}
              onChange={setAgainst}
              onExtras={setExtras}
              onSummaryRead={() => setSummaryToRead(false)}
              onSummaryToRead={() => setSummaryToRead(true)}
              summaryToRead={summaryToRead}
              value={against}
            />
          ) : null}
          {againstFailure ? (
            <p
              className="mt-2 text-sm text-destructive"
              data-testid="decision-challenge-failed"
              role="alert"
            >
              {againstFailure}
            </p>
          ) : null}
          {WORK_KINDS.has(kind) && !ctx.work ? (
            // These forms pick from the DAO's work budgets and claims. Until those are read they would say
            // there is nothing to pick, which is not true yet.
            <p
              className="mt-3 text-sm text-muted-foreground"
              data-testid="decision-reading-work"
              role="status"
            >
              {ctx.workError
                ? `Couldn't read the work budgets from the network: ${ctx.workError}`
                : "Reading the work budgets from the network…"}
            </p>
          ) : kind === "budget" ? (
            <WorkBudgetForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`b${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "project" ? (
            <>
              {sponsor ? (
                <p
                  className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-sm"
                  data-testid="decision-from-suggestion"
                >
                  Filled in from a suggestion: “{sponsor.name}” for{" "}
                  {sponsor.shares} Shares. Once it is approved, the person who
                  suggested it submits work in it like anyone else, and whoever
                  manages it accepts that work for review.
                </p>
              ) : null}
              <ProjectForm
                preset={sponsor ?? undefined}
                blocked={
                  blocked ??
                  // Its words could not be kept if publishing them failed, so the vote waits for room.
                  (pending.full
                    ? "This browser is holding the words of 50 work areas that have not been published yet. Publish them first, from the Decisions or Work tab of each project you opened those votes in, so this work area's words can be kept if publishing them fails."
                    : null)
                }
                busy={busy}
                ctx={ctx}
                gate={gate}
                key={`p${formKey}`}
                onSubmit={submit}
              />
            </>
          ) : kind === "award" ? (
            <AwardForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`a${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "freeze" ? (
            <FreezeForm
              initialPick={challenge ? challengePickKey(challenge) : undefined}
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`z${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "unwind" ? (
            <UnwindForm
              initialPick={challenge ? challengePickKey(challenge) : undefined}
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`u${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "slash" ? (
            <SlashForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`s${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "close" ? (
            <CloseBudgetForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`c${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "payouts" ? (
            <PayoutsForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`o${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "funding" ? (
            <FundingDecisionForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`f${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "rounds" ? (
            <RoundsDecisionForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`w${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "trading" ? (
            <TradingForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`t${formKey}`}
              onSubmit={submit}
            />
          ) : (
            <>
              <div
                className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                data-testid="decision-pay-warning"
                role="note"
              >
                <p>
                  This pays straight out of the treasury. No reviewer checks
                  anything before it goes, and nothing checks what the money is
                  spent on. If it is for work someone will do, set aside a work
                  budget instead: the money then leaves only for work the
                  reviewers approve.
                </p>
                <Button
                  className="mt-2"
                  data-testid="decision-pay-use-budget"
                  onClick={() => setKind("budget")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Set aside a work budget instead
                </Button>
              </div>
              <PayForm
                blocked={blocked}
                busy={busy}
                ctx={payCtx}
                gate={gate}
                key={`y${formKey}`}
                onSubmit={submit}
              />
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}
