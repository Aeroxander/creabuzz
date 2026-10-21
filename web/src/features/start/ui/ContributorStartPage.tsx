/**
 * Start a contributor project: a DAO with no sale, whose Shares are earned only for accepted work.
 *
 * The page says plainly what the project cannot do before it asks for anything, shows who would hold what if the
 * whole first budget were awarded, and then makes it in one transaction and publishes it (`use-contributor-start.ts`).
 * People can claim work the moment it exists. A run cut short by a reload or a refusal is offered again from where it
 * stopped.
 */

import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useState } from "react";

import {
  PeoplePicker,
  TextAreaField,
  TextField,
} from "@/features/launchpad/ui/decision-fields";
import { testRecordsNotice } from "@/features/launchpad/lib/test-network";
import { cn } from "@/shared/lib/cn";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import {
  CONTRIBUTOR_STEP_LABELS,
  CONTRIBUTOR_STEPS,
} from "../lib/contributor-flow";
import {
  CONTRIBUTOR_DEFAULTS,
  type ContributorDraft,
  contributorIssue,
  contributorSymbol,
  sharePreview,
  formatBps,
  formatWhole,
} from "../lib/contributor-project";
import { useContributorStart } from "../use-contributor-start";

const EMPTY: ContributorDraft = {
  name: "",
  pitch: "",
  symbol: "",
  ...CONTRIBUTOR_DEFAULTS,
  reviewers: "",
  quorum: "",
  projectName: "",
  projectCheck: "",
};

/** What a contributor project is and is not, said before the form; on a test network, what its Shares are worth. */
function WhatItIs({ testNotice }: { testNotice: string | null }) {
  return (
    <Card className="p-5" data-testid="contributor-no-raise">
      <h2 className="text-base font-bold">This project cannot raise money</h2>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          There is no sale. Nobody can buy Shares from the project, and this app
          gives a contributor project no way to start one.
        </li>
        <li>
          Shares are earned only for accepted work: someone claims a task, the
          reviewers you name approve it, and the project votes to award the
          Shares.
        </li>
        <li>
          People can claim work as soon as the project exists: its first work
          budget and first project are set up with it, with no vote to wait for.
        </li>
        <li>
          You start with some Shares so you can open and back the project's
          votes. The project's Contributions tab shows everyone who holds Shares
          from work, how many, and for what.
        </li>
        <li>
          Shares cannot be sent from one wallet to another, so nobody can sell
          them. The project can vote to change that later.
        </li>
      </ul>
      {testNotice ? (
        <p
          className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-sm font-medium"
          data-testid="contributor-test-records"
        >
          {testNotice}
        </p>
      ) : null}
    </Card>
  );
}

function Steps({
  flow,
}: {
  flow: ReturnType<typeof useContributorStart>["flow"];
}) {
  return (
    <ol className="flex flex-col gap-2" data-testid="contributor-steps">
      {CONTRIBUTOR_STEPS.map((step, index) => {
        const status = flow.steps[step];
        return (
          <li
            className="flex items-center gap-3 text-sm"
            data-status={status}
            data-testid={`contributor-step-${step}`}
            key={step}
          >
            <span
              aria-hidden
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                status === "done"
                  ? "bg-primary text-primary-foreground"
                  : status === "failed"
                    ? "bg-destructive text-destructive-foreground"
                    : "bg-foreground/10 text-foreground/70",
              )}
            >
              {status === "done" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                index + 1
              )}
            </span>
            <span className={status === "active" ? "font-semibold" : undefined}>
              {CONTRIBUTOR_STEP_LABELS[step]}
              {status === "active" ? " (check your wallet)" : ""}
              {status === "done" ? " (done)" : ""}
              {status === "failed" ? " (stopped)" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ContributorStartPage() {
  const start = useContributorStart();
  const { job, flow, gate, wallet } = start;
  const [draft, setDraft] = useState<ContributorDraft>(EMPTY);
  const [symbolTouched, setSymbolTouched] = useState(false);
  const [tried, setTried] = useState(false);

  const set = (field: keyof ContributorDraft) => (value: string) => {
    setDraft((current) => {
      const next = { ...current, [field]: value };
      // The short name follows the name until the founder types their own.
      if (field === "name" && !symbolTouched)
        next.symbol = value.trim() ? contributorSymbol(value) : "";
      return next;
    });
    if (field === "symbol") setSymbolTouched(true);
  };

  const issue = contributorIssue(draft, wallet.address);
  const preview = sharePreview(draft);

  const done = job !== null && flow.phase === "done";
  const unfinished = job !== null && !done;
  const projectLink = job
    ? {
        to: "/launchpad/$launchId" as const,
        params: { launchId: job.launchId },
        search: { author: job.author, tab: "work" as const },
      }
    : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <PageHeader
        description="A project with no money in it: the token, its Shares, is shared out only for work the reviewers accept."
        title="Start a contributor project"
      />
      <WhatItIs testNotice={testRecordsNotice(start.network?.chainId)} />

      {job ? (
        <Card className="flex flex-col gap-4 p-5" data-testid="contributor-run">
          <h2 className="text-base font-bold">{job.draft.name}</h2>
          <Steps flow={flow} />
          {flow.errorMessage ? (
            <p
              className="text-sm text-destructive"
              data-testid="contributor-failure"
              role="alert"
            >
              {flow.errorMessage}
            </p>
          ) : null}
          {done && projectLink ? (
            <div className="flex flex-col gap-3" data-testid="contributor-done">
              <p className="text-sm">
                The project exists, with its first work budget and its first
                project, and people can claim work on it now. You take each
                claim on, the reviewers you named approve it, and then the
                project votes to award the Shares. Share the link to the Work
                tab with the people you want to work with.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild data-testid="contributor-open-project">
                  <Link {...projectLink}>Open the project's work</Link>
                </Button>
                <Button onClick={start.clear} type="button" variant="outline">
                  Start another
                </Button>
              </div>
            </div>
          ) : null}
          {unfinished && !start.running ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="contributor-resume"
                disabled={
                  !wallet.address ||
                  wallet.address.toLowerCase() !== job.founder
                }
                onClick={start.resume}
                type="button"
              >
                {flow.phase === "failed" ? "Try again" : "Finish setting it up"}
              </Button>
              {wallet.address &&
              wallet.address.toLowerCase() !== job.founder ? (
                <span className="text-xs text-muted-foreground">
                  Connect the wallet that started it: {job.founder}
                </span>
              ) : null}
              {job.dao ? null : (
                <Button onClick={start.clear} type="button" variant="ghost">
                  Discard it
                </Button>
              )}
            </div>
          ) : null}
        </Card>
      ) : (
        <Card
          className="flex flex-col gap-4 p-5"
          data-testid="contributor-form"
        >
          <TextField
            label="Project name"
            onChange={set("name")}
            testId="contributor-name"
            value={draft.name}
          />
          <TextField
            hint="One sentence: what it is and who it is for."
            label="What it is"
            onChange={set("pitch")}
            testId="contributor-pitch"
            value={draft.pitch}
          />
          <TextField
            hint="The token's short name, 2 to 8 letters or numbers."
            label="Short name"
            onChange={set("symbol")}
            testId="contributor-symbol"
            value={draft.symbol}
          />
          <TextField
            hint="Held by your connected wallet, so you can open and back the first votes."
            inputMode="numeric"
            label="Your starting Shares"
            onChange={set("founderShares")}
            testId="contributor-founder-shares"
            value={draft.founderShares}
          />
          <TextField
            hint="The first work budget: Shares the project may award for accepted work, in all."
            inputMode="numeric"
            label="Shares to earn"
            onChange={set("budgetShares")}
            testId="contributor-budget-shares"
            value={draft.budgetShares}
          />
          <TextField
            hint="The most any one piece of the project (say, the docs) may award."
            inputMode="numeric"
            label="Most for one project"
            onChange={set("projectCap")}
            testId="contributor-project-cap"
            value={draft.projectCap}
          />
          <TextAreaField
            after={
              <PeoplePicker
                onPick={(address) =>
                  setDraft((current) => ({
                    ...current,
                    reviewers: current.reviewers
                      .toLowerCase()
                      .includes(address.toLowerCase())
                      ? current.reviewers
                      : current.reviewers.trim()
                        ? `${current.reviewers.trimEnd()}\n${address}`
                        : address,
                  }))
                }
                testId="contributor-reviewers-people"
              />
            }
            hint="Wallet addresses of the people who check each claim, one per line. Pick people other than the ones who will do the work."
            label="Reviewers"
            onChange={set("reviewers")}
            placeholder="0x… (one wallet address per line)"
            testId="contributor-reviewers"
            value={draft.reviewers}
          />
          <TextField
            hint="Leave empty for a simple majority of the reviewers."
            inputMode="numeric"
            label="How many reviewers must agree"
            onChange={set("quorum")}
            testId="contributor-quorum"
            value={draft.quorum}
          />
          <TextField
            hint="The first thing people can work on, in a word or two (for example: docs). You manage it: you take each claim on."
            label="First project"
            onChange={set("projectName")}
            placeholder="docs"
            testId="contributor-project-name"
            value={draft.projectName}
          />
          <TextAreaField
            hint="Every claim says it meets this, and the reviewers check the work against these words."
            label="What finished work looks like"
            onChange={set("projectCheck")}
            placeholder="The pages are merged and reviewed"
            testId="contributor-project-check"
            value={draft.projectCheck}
          />

          {preview ? (
            <p
              className="rounded-lg bg-secondary/60 px-3 py-2 text-sm"
              data-testid="contributor-preview"
            >
              You start with {formatWhole(preview.founderWhole)} Shares. If all{" "}
              {formatWhole(preview.budgetWhole)} in this budget are earned,
              contributors will hold {formatBps(preview.contributorsBps)} of all
              Shares and you {formatBps(10_000 - preview.contributorsBps)}.
              Later budgets are voted like any other decision.
            </p>
          ) : null}

          {tried && issue ? (
            <p
              className="text-sm text-destructive"
              data-testid="contributor-problem"
              role="alert"
            >
              {issue.message}
            </p>
          ) : null}
          {gate.ok ? null : (
            <div
              className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
              data-testid="contributor-gate"
            >
              <span>{gate.message}</span>
              {gate.reason === "wallet" && wallet.hasProvider ? (
                <Button
                  disabled={wallet.connecting}
                  onClick={() => void wallet.connect()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Connect wallet
                </Button>
              ) : null}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="contributor-submit"
              disabled={!gate.ok}
              onClick={() => {
                setTried(true);
                if (issue) return;
                start.start(draft);
              }}
              type="button"
            >
              Start the project
            </Button>
            <span className="text-xs text-muted-foreground">
              Your wallet is asked once.
            </span>
          </div>
        </Card>
      )}

      <p className="text-sm text-muted-foreground">
        Want to raise money instead?{" "}
        <Link className="underline" to="/start">
          See the other ways to start
        </Link>
        .
      </p>
    </div>
  );
}
