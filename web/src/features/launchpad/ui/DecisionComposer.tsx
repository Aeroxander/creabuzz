import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DecisionDraft } from "../lib/dao-actions";
import { formatUnits } from "../lib/dao-actions";
import type { DecisionsSnapshot } from "../lib/decisions";
import { encodeOpenProposalWithAction } from "../lib/vote-tx";
import {
  AwardForm,
  CollectFeesForm,
  type FormContext,
  MarketForm,
  PayForm,
  ProjectForm,
} from "./decision-forms";
import { WorkBudgetForm } from "./WorkBudgetForm";

type Kind = "budget" | "project" | "award" | "market" | "fees" | "pay";

const KINDS: { id: Kind; label: string; about: string }[] = [
  {
    id: "budget",
    label: "Set aside a work budget",
    about: "Shares (and optionally money) for people to earn by doing work.",
  },
  {
    id: "project",
    label: "Approve a project",
    about:
      "A project inside a work budget, with a manager and a way to judge the work.",
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
    id: "pay",
    label: "Pay from the treasury",
    about: "Send some of the treasury's money to someone.",
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
}: {
  snapshot: DecisionsSnapshot;
  ctx: FormContext;
  busy: string | null;
  gate: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("budget");
  const [done, setDone] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const capacity = snapshot.walletCapacity;
  const blocked =
    capacity === null
      ? null
      : capacity < snapshot.proposalThreshold || capacity === 0n
        ? `You need at least ${formatUnits(snapshot.proposalThreshold, 18)} Shares to put a decision to a vote. You hold ${formatUnits(capacity, 18)}.`
        : null;

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
          {kind === "budget" ? (
            <WorkBudgetForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`b${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "project" ? (
            <ProjectForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`p${formKey}`}
              onSubmit={submit}
            />
          ) : kind === "award" ? (
            <AwardForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`a${formKey}`}
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
            <PayForm
              blocked={blocked}
              busy={busy}
              ctx={ctx}
              gate={gate}
              key={`y${formKey}`}
              onSubmit={submit}
            />
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
