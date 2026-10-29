/**
 * Start a contributor project: a DAO with no token sale, whose new Shares come only from awards for reviewed work.
 *
 * Before it asks for anything the page says what the setup is (no sale, the founder's starting Shares, review and award
 * as separate steps, transfers locked) and who holds what at the start and if the whole first budget were awarded;
 * then it makes the project in one transaction and publishes it (`use-contributor-start.ts`). People can submit work
 * the moment it exists. A run cut short by a reload or a refusal is offered again from where it stopped.
 */

import { Link, useSearch } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import {
  PeoplePicker,
  TextAreaField,
  TextField,
} from "@/features/launchpad/ui/decision-fields";
import { testRecordsNotice } from "@/features/launchpad/lib/test-network";
import { WalletStrip } from "@/features/launchpad/ui/auction-widgets";
import { usePeopleWithWallets } from "@/features/launchpad/use-people";
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
  emptyProject,
  sharePreview,
  formatBps,
  formatWhole,
} from "../lib/contributor-project";
import type { PitchStart } from "../lib/from-pitch";
import { useContributorStart } from "../use-contributor-start";
import { useStartFromPitch } from "../use-start-from-pitch";
import { FirstProjectsField } from "./FirstProjectsField";
import { RemixFields } from "./RemixFields";

const EMPTY: ContributorDraft = {
  name: "",
  pitch: "",
  symbol: "",
  ...CONTRIBUTOR_DEFAULTS,
  reviewers: "",
  quorum: "",
  projects: [emptyProject(CONTRIBUTOR_DEFAULTS.projectCap)],
};

/** What starting from the Projects board does with the team (D84), said above the form. */
function FromBoard({ start }: { start: PitchStart }) {
  return (
    <Card className="p-5" data-testid="contributor-from-board">
      <h2 className="text-base font-bold">From the Projects board</h2>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          Each role is a first work area that can award up to its stake. The
          person in it submits work, reviewers check it, and Shareholders then
          vote separately on each award: approval does not guarantee Shares.
          Nothing is handed out up front.
        </li>
        <li>
          1,000,000 Shares stand for the whole project once every role's work is
          awarded.
          {start.founderDefaulted
            ? " You declared no stake, so you start with 1%, enough to open votes."
            : " Your declared stake is what you start with."}
        </li>
        {start.roomWhole > 0n ? (
          <li>
            The first budget also has room for {formatWhole(start.roomWhole)}{" "}
            Shares that no role takes yet, for people who join later.
          </li>
        ) : null}
        {start.leftOut.length > 0 ? (
          <li data-testid="contributor-from-board-left-out">
            A project starts with at most eight work areas, so{" "}
            {start.leftOut.join(", ")} can be added by a vote once it exists.
          </li>
        ) : null}
      </ul>
    </Card>
  );
}

/** What a contributor project is and is not, said before the form; on a test network, what its Shares are worth. */
function WhatItIs({ testNotice }: { testNotice: string | null }) {
  return (
    <Card className="p-5" data-testid="contributor-no-raise">
      <h2 className="text-base font-bold">Starts without a token sale</h2>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          You start with Shares, which are votes in the project. At first you
          may hold every Share that votes.
        </li>
        <li>
          New Shares come only from awards: someone submits work, the reviewers
          you name check it, then the project votes on an award. Approval alone
          gives no Shares.
        </li>
        <li>
          Shares can&apos;t be sold at first. Opening transfers takes two
          project votes, at least 30 days apart.
        </li>
        <li>The project can still receive money into its shared funds.</li>
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
              {status === "active" ? " (approve it when asked)" : ""}
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
  const search = useSearch({ from: "/start/contributor" });
  const fromBoard = useStartFromPitch(search.project, search.author);
  const [draft, setDraft] = useState<ContributorDraft>(EMPTY);
  const [symbolTouched, setSymbolTouched] = useState(false);
  const [tried, setTried] = useState(false);

  // A team from the Projects board fills the form once, when it has been read; the founder can still change anything.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !fromBoard.start) return;
    setDraft(fromBoard.start.draft);
    setSymbolTouched(true);
    setSeeded(true);
  }, [seeded, fromBoard.start]);

  const set =
    (field: Exclude<keyof ContributorDraft, "projects">) => (value: string) => {
      setDraft((current) => {
        const next = { ...current, [field]: value };
        // The short name follows the name until the founder types their own.
        if (field === "name" && !symbolTouched)
          next.symbol = value.trim() ? contributorSymbol(value) : "";
        // A project still at the most for one project follows it when it changes.
        if (field === "projectCap")
          next.projects = current.projects.map((project) =>
            project.shares === current.projectCap
              ? { ...project, shares: value }
              : project,
          );
        return next;
      });
      if (field === "symbol") setSymbolTouched(true);
    };

  // Every address known to be the founder's: the account they act with, and any wallet their name is linked to (D139).
  const people = usePeopleWithWallets();
  const founderAddresses = [
    ...(wallet.address ? [wallet.address] : []),
    ...(people.data ?? [])
      .filter((person) => person.pubkey === start.me)
      .map((person) => person.address),
  ];
  const issue = contributorIssue(draft, founderAddresses);
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
        description="Set up a project where reviewed work can earn Shares, the project's voting tokens."
        title="Start a contributor project"
      />
      <WhatItIs testNotice={testRecordsNotice(start.network?.chainId)} />
      {fromBoard.start ? <FromBoard start={fromBoard.start} /> : null}
      {fromBoard.problem ? (
        <p
          className="text-sm text-destructive"
          data-testid="contributor-from-board-problem"
          role="alert"
        >
          {fromBoard.problem}
        </p>
      ) : null}

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
              <h3 className="text-base font-bold">
                Your project is ready for contributions
              </h3>
              <p className="text-sm">
                Its first work budget and work areas are ready, and people can
                submit work now. You accept each submission into a work area,
                the reviewers you named check it, and Shareholders then vote on
                each award. Share the Work page so people can see what needs
                doing.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild data-testid="contributor-open-project">
                  <Link {...projectLink}>Open work</Link>
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
                  Use the account that started it: {job.founder}
                </span>
              ) : null}
              <WalletStrip
                testIdPrefix="contributor-resume-account"
                wallet={wallet}
              />
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
            hint="A short code for the Shares, 2 to 8 letters or numbers, like CREA."
            label="Short name"
            onChange={set("symbol")}
            testId="contributor-symbol"
            value={draft.symbol}
          />
          <TextField
            hint="Held by the account you act with, so you can open and back the first votes."
            inputMode="numeric"
            label="Your starting Shares"
            onChange={set("founderShares")}
            testId="contributor-founder-shares"
            value={draft.founderShares}
          />
          <TextField
            hint="The first work budget: a limit on future awards in all, not a payment promised for any one task."
            inputMode="numeric"
            label="Shares available for work"
            onChange={set("budgetShares")}
            testId="contributor-budget-shares"
            value={draft.budgetShares}
          />
          <TextField
            hint="The most any one work area (say, the docs) may award."
            inputMode="numeric"
            label="Most for one work area"
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
                exclude={start.me ? [start.me] : []}
                testId="contributor-reviewers-people"
              />
            }
            hint="Wallet addresses of the people who check submitted work, one per line. Pick people other than the ones who will do the work. Reviewing does not itself give them Shares or votes."
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
          <FirstProjectsField
            cap={draft.projectCap}
            onChange={(projects) =>
              setDraft((current) => ({ ...current, projects }))
            }
            problemIndex={
              tried && issue?.field === "projects" ? issue.index : null
            }
            projects={draft.projects}
          />
          <RemixFields
            draft={draft}
            onChange={(patch) =>
              setDraft((current) => ({ ...current, ...patch }))
            }
          />

          {preview ? (
            <p
              className="rounded-lg bg-secondary/60 px-3 py-2 text-sm"
              data-testid="contributor-preview"
            >
              <span className="block" data-testid="contributor-preview-start">
                <strong>At the start:</strong> you hold{" "}
                {formatWhole(preview.founderWhole)} of{" "}
                {formatWhole(preview.founderWhole)} Shares, every Share that
                votes. The work budget can award up to{" "}
                {formatWhole(preview.budgetWhole)} more; those do not vote until
                they are awarded.
              </span>
              <span
                className="mt-1 block"
                data-testid="contributor-preview-full"
              >
                <strong>If the whole work budget is awarded</strong> (an
                illustration, not a prediction): contributors would hold{" "}
                {formatBps(preview.contributorsBps)} of all Shares and you{" "}
                {formatBps(10_000 - preview.contributorsBps)}, if nothing else
                changes. Later budgets are voted like any other decision.
              </span>
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
          <WalletStrip testIdPrefix="contributor-account" wallet={wallet} />
          {/* The account strip above says what to do about the account; the gate says the rest. */}
          {gate.ok || gate.reason === "wallet" ? null : (
            <div
              className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
              data-testid="contributor-gate"
            >
              <span>{gate.message}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="contributor-submit"
              disabled={!gate.ok}
              onClick={() => {
                setTried(true);
                if (issue) return;
                start.start(draft, search.project);
              }}
              type="button"
            >
              Start the project
            </Button>
            <span className="text-xs text-muted-foreground">
              {wallet.kind === "passkey"
                ? "Your passkey is asked once, and the fees are covered."
                : "Your wallet is asked once."}
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
