import { type ChallengeIntent, challengePickKey } from "../lib/challenge";
import type { SponsorIntent } from "../lib/sponsor";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DecisionDraft } from "../lib/dao-actions";
import { formatUnits } from "../lib/dao-actions";
import type { DecisionsSnapshot } from "../lib/decisions";
import { encodeOpenProposalWithAction } from "../lib/vote-tx";
import { workAreaUpdateContent } from "../lib/ways-to-help";
import type { Launch } from "../models";
import { usePublishMirror } from "../use-launches";
import { KIND_LAUNCH_UPDATE } from "@/shared/constants/kinds";
import {
  AwardForm,
  CollectFeesForm,
  type FormContext,
  MarketForm,
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

type Kind =
  | "budget"
  | "project"
  | "award"
  | "market"
  | "fees"
  | "pay"
  | "freeze"
  | "unwind"
  | "slash"
  | "close"
  | "trading";

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
    label: "Award Shares for a claim",
    about: "Pay out Shares for work the reviewers approved.",
  },
  {
    id: "market",
    label: "Put Shares on the market",
    about:
      "Let people buy and sell the Shares, with a fee to the DAO on every trade.",
  },
  {
    id: "fees",
    label: "Collect the trading fees",
    about: "Move the fees the market has collected into the treasury.",
  },
  {
    id: "freeze",
    label: "Freeze a claim",
    about:
      "Stop a payment you doubt. Nothing is paid for it until a later decision unwinds it.",
  },
  {
    id: "unwind",
    label: "Unwind a frozen claim",
    about: "Send the money reserved for it back to the budget.",
  },
  {
    id: "slash",
    label: "Take a reviewer's bond",
    about: "After an approval you dispute. It is paid to the DAO.",
  },
  {
    id: "close",
    label: "Close a work budget",
    about: "Stop new claims and take back what is not set aside.",
  },
  {
    id: "trading",
    label: "Open trading",
    about:
      "Let Shares be sent between wallets, and so bought and sold. It can open only 30 days after a vote announces it.",
  },
  {
    id: "pay",
    label: "Pay from the treasury",
    about:
      "Send some of the treasury's money to someone. No reviewer checks it.",
  },
];

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

  const capacity = snapshot.walletCapacity;
  const blocked =
    capacity === null
      ? null
      : capacity < snapshot.proposalThreshold || capacity === 0n
        ? `You need at least ${formatUnits(snapshot.proposalThreshold, 18)} Shares to put a decision to a vote. You hold ${formatUnits(capacity, 18)}.`
        : null;

  const publish = usePublishMirror();
  // A work area's words the chain does not keep, published beside its vote; held here while publishing them failed.
  const [unpublished, setUnpublished] = useState<
    DecisionDraft["workArea"] | null
  >(null);
  const publishWords = async (area: NonNullable<DecisionDraft["workArea"]>) => {
    if (!launch) return;
    try {
      await publish.mutateAsync({
        kind: KIND_LAUNCH_UPDATE,
        author: launch.record.author,
        launchId: launch.record.id,
        content: workAreaUpdateContent(area),
      });
      setUnpublished(null);
    } catch {
      setUnpublished(area);
    }
  };
  const submit = async (draft: DecisionDraft) => {
    setDone(null);
    const landed = await onSend(
      "open-decision",
      snapshot.dao,
      encodeOpenProposalWithAction({
        op: 0,
        to: draft.to,
        value: 0n,
        data: draft.data,
        nonce: nonce(),
      }),
    );
    if (landed) {
      setDone(draft.title);
      setFormKey((k) => k + 1);
      setOpen(false);
      // The chain keeps only the hash of a work area's words: publish the words, so people can see what to deliver.
      if (draft.workArea) await publishWords(draft.workArea);
    }
  };

  return (
    <Card className="p-4" data-testid="decision-composer">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Put something to a vote</h3>
          <p className="text-xs text-muted-foreground">
            Anyone holding enough Shares can open a decision.
          </p>
        </div>
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
      </div>
      {done ? (
        <p className="mt-2 text-sm" data-testid="decision-opened" role="status">
          Opened “{done}” for voting. It is in the list below.
        </p>
      ) : null}
      {unpublished ? (
        <p
          className="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-300"
          data-testid="decision-words-unpublished"
          role="alert"
        >
          The vote is open, but the work area&apos;s words could not be
          published, so people cannot read what finished work looks like.
          <Button
            disabled={publish.isPending}
            onClick={() => void publishWords(unpublished)}
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
          <fieldset className="grid gap-2 sm:grid-cols-3">
            <legend className="sr-only">What kind of decision</legend>
            {KINDS.filter(
              (k) => ctx.exchange || (k.id !== "market" && k.id !== "fees"),
            ).map((k) => (
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
                  {k.about}
                </span>
              </button>
            ))}
          </fieldset>
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
                blocked={blocked}
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
          ) : kind === "trading" ? (
            <TradingForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`t${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "market" ? (
            <MarketForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`m${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "pay" ? (
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
                  budget instead: the money then leaves only against claims the
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
                ctx={ctx}
                gate={gate}
                key={`y${formKey}`}
                onSubmit={submit}
              />
            </>
          ) : (
            <CollectFeesForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`f${formKey}`}
              onSubmit={submit}
            />
          )}
        </div>
      ) : null}
    </Card>
  );
}
