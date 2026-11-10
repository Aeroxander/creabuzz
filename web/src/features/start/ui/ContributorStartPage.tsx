/**
 * Start a contributor project: a DAO with no token sale, whose new Shares come only from awards for reviewed work.
 *
 * Before it asks for anything the page says what the setup is (no sale, the founder's starting Shares, review and award
 * as separate steps, selling locked) and who holds what at the start and if the whole first budget were awarded;
 * then it makes the project in one transaction and publishes it (`use-contributor-start.ts`). People can submit work
 * the moment it exists. A run cut short by a reload or a refusal is offered again from where it stopped.
 */

import { Link, useSearch } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import {
  PeoplePicker,
  TextAreaField,
  TextField,
} from "@/features/launchpad/ui/decision-fields";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { remixesOffered } from "@/features/launchpad/lib/remixes-offered";
import { testRecordsNotice } from "@/features/launchpad/lib/test-network";
import { WalletStrip } from "@/features/launchpad/ui/account-widgets";
import { usePeopleWithWallets } from "@/features/launchpad/use-people";
import { cn } from "@/shared/lib/cn";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { SIGNING_BLOCKED_MESSAGE } from "@/shared/lib/nostr-signer";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import {
  CONTRIBUTOR_STEP_LABELS,
  CONTRIBUTOR_STEPS,
} from "../lib/contributor-flow";
import { LOCKED_GATE_MESSAGE } from "../lib/contributor-gate";
import {
  DONE_TEXT,
  PITCH_HINT,
  QUORUM_HINT,
  REVIEWERS_HINT,
  WHAT_IT_IS_POINTS,
  startHeaderDescription,
  whatItIsTitle,
} from "../lib/contributor-start-copy";
import {
  CONTRIBUTOR_DEFAULTS,
  type ContributorDraft,
  contributorIssue,
  contributorSymbol,
  emptyProject,
  founderShareWarning,
  sharePreview,
  formatBps,
  formatWhole,
  withReviewer,
} from "../lib/contributor-project";
import {
  clearFormDraft,
  formDraftKey,
  keptFormFor,
  loadFormDraft,
  saveFormDraft,
} from "../lib/start-form-draft";
import { clearIdea, type IdeaHandoff, peekIdea } from "../lib/from-idea";
import type { PitchStart } from "../lib/from-pitch";
import { useContributorStart } from "../use-contributor-start";
import { useStartFromPitch } from "../use-start-from-pitch";
import { FirstProjectsField } from "./FirstProjectsField";
import { RemixFields } from "./RemixFields";
import { ReviewersPicked } from "./ReviewersPicked";
import { WeeklySaleFields } from "./WeeklySaleFields";
import { weeklySaleIssue } from "../lib/weekly-sale";

const EMPTY: ContributorDraft = {
  name: "",
  pitch: "",
  symbol: "",
  ...CONTRIBUTOR_DEFAULTS,
  reviewers: "",
  quorum: "",
  reviewerTies: "",
  projects: [emptyProject(CONTRIBUTOR_DEFAULTS.projectCap)],
};

/** What starting from the Projects board does with the team (D84), said above the form. */
function FromBoard({ start }: { start: PitchStart }) {
  return (
    <Card className="p-5" data-testid="contributor-from-board">
      <h2 className="text-base font-bold">From the Projects board</h2>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
        <li>Each role is a first work area that can award up to its stake.</li>
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

/**
 * What a contributor project is and is not, said before the form; on a test network, what its Shares are worth. Where
 * the build offers raises it is set against one; a contributor-only build has no sale to compare it with.
 */
function WhatItIs({
  testNotice,
  raises,
}: {
  testNotice: string | null;
  raises: boolean;
}) {
  return (
    <Card className="p-5" data-testid="contributor-no-raise">
      <h2 className="text-base font-bold">{whatItIsTitle(raises)}</h2>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
        {WHAT_IT_IS_POINTS.map((point) => (
          <li key={point}>{point}</li>
        ))}
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
  // What was typed here before a reload or a closed tab, for this server, account and board project (`lib/start-form-draft.ts`).
  // Follows the account: someone who signs in on this page gets their form kept from then on.
  const formKey = useMemo(
    () =>
      start.me
        ? formDraftKey({
            server: relayWsUrl(),
            account: start.me,
            fromBoard: search.project,
          })
        : null,
    [start.me, search.project],
  );
  // The key the form on screen belongs to; nothing is kept under a new key before its own copy has been read.
  const [loadedKey, setLoadedKey] = useState(formKey);
  const [restored, setRestored] = useState<ContributorDraft | null>(() =>
    formKey ? loadFormDraft(formKey) : null,
  );
  // True when this browser refused to keep the form, so a reload would lose it.
  const [saveRefused, setSaveRefused] = useState(false);
  const [draft, setDraft] = useState<ContributorDraft>(restored ?? EMPTY);
  const [symbolTouched, setSymbolTouched] = useState(restored !== null);
  const [tried, setTried] = useState(false);
  // Picking someone already among the reviewers changes nothing: said, instead of doing nothing.
  const [pickNote, setPickNote] = useState<string | null>(null);

  // The founder's own project, handed over by its page to have Shares set up for it. It is kept in this browser until
  // the project is made (or the founder asks for a separate one), so a reload or a closed tab still carries on the same
  // project instead of quietly making a second one. Never over a board team.
  const [fromIdea, setFromIdea] = useState<IdeaHandoff | null>(() =>
    search.project ? null : peekIdea(localStorage, start.me, relayWsUrl()),
  );
  // A form brought back from an earlier visit already holds what the founder made of it: it is not filled over.
  const openedWithForm = useRef(restored !== null);
  useEffect(() => {
    if (!fromIdea || openedWithForm.current) return;
    setDraft((current) => ({
      ...current,
      name: fromIdea.name,
      pitch: fromIdea.pitch,
      symbol: contributorSymbol(fromIdea.name),
    }));
  }, [fromIdea]);
  const separateProject = () => {
    clearIdea(localStorage);
    setFromIdea(null);
  };

  // A team from the Projects board fills the form once, when it has been read; the founder can still change anything.
  // A form brought back from an earlier visit is not filled over: it already holds what the founder made of it.
  const [seeded, setSeeded] = useState(restored !== null);
  // Signed in (or switched account) on this page: that account's earlier form comes back, unless something is typed.
  useEffect(() => {
    if (formKey === loadedKey) return;
    const kept = formKey ? keptFormFor(formKey, draft, EMPTY) : null;
    setLoadedKey(formKey);
    if (!kept) return;
    setRestored(kept);
    setDraft(kept);
    setSymbolTouched(true);
    setSeeded(true);
  }, [formKey, loadedKey, draft]);
  useEffect(() => {
    if (seeded || !fromBoard.start) return;
    setDraft(fromBoard.start.draft);
    setSymbolTouched(true);
    setSeeded(true);
  }, [seeded, fromBoard.start]);

  const done = job !== null && flow.phase === "done";
  // The project is made: the hand-off has done its work, and a later visit to this form starts a new project.
  useEffect(() => {
    if (done) clearIdea(localStorage);
  }, [done]);
  // Kept as it is typed, until the project is made; then it is not needed (the run kept its own copy).
  useEffect(() => {
    if (!formKey || formKey !== loadedKey || job !== null) return;
    setSaveRefused(!saveFormDraft(formKey, draft, EMPTY));
  }, [formKey, loadedKey, draft, job]);
  useEffect(() => {
    if (formKey && done) clearFormDraft(formKey);
  }, [formKey, done]);
  const startOver = () => {
    if (formKey) clearFormDraft(formKey);
    setRestored(null);
    setDraft(EMPTY);
    setSymbolTouched(false);
    setTried(false);
    setPickNote(null);
    // From the Projects board: its team fills the form again.
    setSeeded(false);
  };

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
  const preview = sharePreview(draft);
  // On the weekly-sale kit the sale fields are part of the form: their problem comes after the rest.
  const weekly = start.network?.weekly ?? null;
  const saleIssue = weekly
    ? weeklySaleIssue(draft, preview?.founderWhole)
    : null;
  const issue =
    contributorIssue(draft, founderAddresses) ??
    (saleIssue ? { ...saleIssue, index: null, part: null } : null);
  const warning = preview ? founderShareWarning(preview) : null;
  // A problem is said under the field it is about, once the founder has tried to start.
  const errorFor = (field: keyof ContributorDraft) =>
    tried && issue?.field === field ? issue.message : null;
  const form = useRef<HTMLDivElement | null>(null);
  // Pressing Start with a problem takes the founder to the field it is about.
  const showProblem = () =>
    requestAnimationFrame(() => {
      const field = form.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"]',
      );
      field?.scrollIntoView({ block: "center" });
      field?.focus({ preventScroll: true });
    });

  const raises = raisesOffered();
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
        description={startHeaderDescription(raises)}
        title="Start a contributor project"
      />
      <WhatItIs
        raises={raises}
        testNotice={testRecordsNotice(start.network?.chainId)}
      />
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
            flow.errorMessage.includes(SIGNING_BLOCKED_MESSAGE) ? (
              // Locked after the DAO was made: unlock here, and the run carries on with the step that is left.
              <SignRecovery
                message={flow.errorMessage}
                messageTestId="contributor-failure"
                onUnlocked={start.resume}
                testId="contributor-failure-recovery"
              />
            ) : (
              <p
                className="text-sm text-destructive"
                data-testid="contributor-failure"
                role="alert"
              >
                {flow.errorMessage}
              </p>
            )
          ) : null}
          {flow.errorMessage && start.failureDetails ? (
            <details
              className="text-xs text-muted-foreground"
              data-testid="contributor-failure-details"
            >
              <summary className="cursor-pointer select-none font-medium">
                Technical details
              </summary>
              <p className="mt-1 break-words font-mono">
                {start.failureDetails}
              </p>
            </details>
          ) : null}
          {done && projectLink ? (
            <div className="flex flex-col gap-3" data-testid="contributor-done">
              <h3 className="text-base font-bold">
                Your project is ready for contributions
              </h3>
              <p className="text-sm">{DONE_TEXT}</p>
              {fromIdea && fromIdea.id === job?.launchId ? (
                <p className="text-sm" data-testid="contributor-same-project">
                  It is the same project as before: its page, goal, updates and
                  record are all still there.
                </p>
              ) : fromIdea ? (
                <p className="text-sm" data-testid="contributor-from-idea-done">
                  Your idea {fromIdea.name} is still listed on its own.{" "}
                  <Link
                    className="font-semibold underline"
                    params={{ launchId: fromIdea.id }}
                    search={{ author: fromIdea.author, tab: "manage" }}
                    to="/launchpad/$launchId"
                  >
                    Take the idea off Discover
                  </Link>{" "}
                  so people find the project instead.
                </p>
              ) : null}
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
          {/* Locked before the run picks up again: unlock here first, as the fresh start asks (the failure above already
              offers its own unlock when the run stopped on it). */}
          {unfinished &&
          !start.running &&
          start.locked &&
          !flow.errorMessage?.includes(SIGNING_BLOCKED_MESSAGE) ? (
            <SignRecovery
              message={LOCKED_GATE_MESSAGE}
              onUnlocked={start.resume}
              testId="contributor-resume-unlock"
            />
          ) : null}
          {unfinished && !start.running ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="contributor-resume"
                disabled={
                  start.locked ||
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
                  Switch to the account you started it with.
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
          ref={form}
        >
          {/* Always there, so a screen reader hears it when this browser stops keeping the form. */}
          <p
            className={
              saveRefused
                ? "rounded-lg bg-secondary/60 px-3 py-2 text-sm"
                : "sr-only"
            }
            data-testid="contributor-form-not-kept"
            role="status"
          >
            {saveRefused
              ? "This browser is not keeping what you type here, so reloading or closing this tab would lose it."
              : null}
          </p>
          {fromIdea ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-sm"
              data-testid="contributor-carry-on"
            >
              <span className="min-w-0 flex-1">
                You are setting up Shares for{" "}
                <span className="font-semibold">{fromIdea.name}</span>. It stays
                the same project: its page, goal, updates and followers carry
                on.
              </span>
              <Button
                data-testid="contributor-separate"
                onClick={separateProject}
                size="sm"
                type="button"
                variant="outline"
              >
                Start a separate project
              </Button>
            </div>
          ) : null}
          {restored ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-sm"
              data-testid="contributor-form-restored"
            >
              <span>What you typed here before is filled in again.</span>
              <Button
                data-testid="contributor-form-start-over"
                onClick={startOver}
                size="sm"
                type="button"
                variant="outline"
              >
                Start over
              </Button>
            </div>
          ) : null}
          <TextField
            error={errorFor("name")}
            label="Project name"
            onChange={set("name")}
            testId="contributor-name"
            value={draft.name}
          />
          <TextField
            error={errorFor("pitch")}
            hint={PITCH_HINT}
            label="What it is"
            onChange={set("pitch")}
            testId="contributor-pitch"
            value={draft.pitch}
          />
          <TextField
            error={errorFor("symbol")}
            hint="A short code for the Shares, 2 to 8 letters or numbers, like CREA."
            label="Short name"
            onChange={set("symbol")}
            testId="contributor-symbol"
            value={draft.symbol}
          />
          <TextField
            after={
              warning ? (
                <span
                  className="text-xs font-medium text-amber-800 dark:text-amber-200"
                  data-testid="contributor-preview-warning"
                  role="status"
                >
                  {warning}
                </span>
              ) : null
            }
            error={errorFor("founderShares")}
            hint="Held by the account you act with, so you can open and back the first votes."
            inputMode="numeric"
            label="Your starting Shares"
            onChange={set("founderShares")}
            testId="contributor-founder-shares"
            value={draft.founderShares}
          />
          <TextField
            error={errorFor("budgetShares")}
            hint="The first work budget: a limit on future awards in all, not a payment promised for any one task."
            inputMode="numeric"
            label="Shares available for work"
            onChange={set("budgetShares")}
            testId="contributor-budget-shares"
            value={draft.budgetShares}
          />
          <TextField
            error={errorFor("projectCap")}
            hint="For example, the docs. Each work area below starts at this size."
            inputMode="numeric"
            label="Most for one work area"
            onChange={set("projectCap")}
            testId="contributor-project-cap"
            value={draft.projectCap}
          />
          <TextAreaField
            after={
              <PeoplePicker
                onPick={(address) => {
                  const next = withReviewer(draft.reviewers, address);
                  setPickNote(
                    next.added ? null : "That person is already a reviewer.",
                  );
                  if (next.added)
                    setDraft((current) => ({
                      ...current,
                      reviewers: withReviewer(current.reviewers, address).text,
                    }));
                }}
                exclude={start.me ? [start.me] : []}
                testId="contributor-reviewers-people"
              />
            }
            error={errorFor("reviewers")}
            hint={REVIEWERS_HINT}
            label="Reviewers"
            onChange={(value) => {
              // Whatever the note said about the last pick no longer holds once the list is edited by hand.
              setPickNote(null);
              set("reviewers")(value);
            }}
            placeholder="Add people from the list, or paste an account address on each line"
            testId="contributor-reviewers"
            value={draft.reviewers}
          />
          {/* Always there, so a screen reader hears the note when it appears. */}
          <p
            className={
              pickNote ? "-mt-2 text-xs text-muted-foreground" : "sr-only"
            }
            data-testid="contributor-reviewers-already"
            role="status"
          >
            {pickNote}
          </p>
          <ReviewersPicked
            me={start.me}
            onMajorityDecides={() =>
              setDraft((current) => ({ ...current, quorum: "" }))
            }
            quorum={draft.quorum}
            reviewers={draft.reviewers}
          />
          <TextField
            error={errorFor("quorum")}
            hint={QUORUM_HINT}
            inputMode="numeric"
            label="How many reviewers must agree"
            onChange={set("quorum")}
            testId="contributor-quorum"
            value={draft.quorum}
          />
          <TextAreaField
            error={errorFor("reviewerTies")}
            hint={
              'Shown on the project\'s page. Say who each reviewer is and any tie to you or to the people who will do the work: a friend, a colleague, family, another account of yours. Write "none" where there is none.'
            }
            label="How you know each reviewer"
            onChange={set("reviewerTies")}
            testId="contributor-reviewer-ties"
            value={draft.reviewerTies ?? ""}
          />
          <FirstProjectsField
            cap={draft.projectCap}
            onChange={(projects) =>
              setDraft((current) => ({ ...current, projects }))
            }
            problem={errorFor("projects")}
            problemIndex={
              tried && issue?.field === "projects" ? issue.index : null
            }
            problemPart={
              tried && issue?.field === "projects" ? issue.part : null
            }
            projects={draft.projects}
          />
          {weekly ? (
            <WeeklySaleFields
              draft={draft}
              errorFor={errorFor}
              onChange={(patch) =>
                setDraft((current) => ({ ...current, ...patch }))
              }
            />
          ) : null}
          {remixesOffered() ? (
            <RemixFields
              draft={draft}
              onChange={(patch) =>
                setDraft((current) => ({ ...current, ...patch }))
              }
            />
          ) : null}

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
          {/* A locked passkey is said, with its unlock, whatever else stands in the way: the project is published under
              the founder's name, so this is checked before anything is sent, never found after the DAO is made. */}
          {start.locked ? (
            <SignRecovery
              message={LOCKED_GATE_MESSAGE}
              onUnlocked={() => {
                start.rereadProjects();
                void people.refetch();
              }}
              testId="contributor-unlock"
            />
          ) : null}
          {/* The account strip above says what to do about the account; the gate says the rest. */}
          {gate.ok ||
          gate.reason === "wallet" ||
          gate.reason === "locked" ? null : (
            <div
              className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
              data-testid="contributor-gate"
            >
              <span>{gate.message}</span>
              {gate.reason === "projects-unreadable" ? (
                <Button
                  data-testid="contributor-projects-retry"
                  onClick={start.rereadProjects}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              ) : null}
            </div>
          )}
          {start.startError ? (
            <p
              className="text-sm text-red-700 dark:text-red-300"
              data-testid="contributor-start-error"
              role="alert"
            >
              {start.startError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="contributor-submit"
              disabled={!gate.ok}
              onClick={() => {
                setTried(true);
                if (issue) {
                  showProblem();
                  return;
                }
                void start.start(
                  draft,
                  search.project,
                  fromIdea
                    ? { id: fromIdea.id, name: fromIdea.name }
                    : undefined,
                );
              }}
              type="button"
            >
              Start the project
            </Button>
            {/* Said only once there is an account to ask: with none, the account line above says what to do. */}
            {wallet.address ? (
              <span className="text-xs text-muted-foreground">
                {wallet.kind === "passkey"
                  ? "You confirm once with your passkey, and we cover the fees."
                  : "Your wallet app asks you to confirm once."}
              </span>
            ) : null}
          </div>
        </Card>
      )}

      {raises ? (
        <p className="text-sm text-muted-foreground">
          Want to raise money instead?{" "}
          <Link className="underline" to="/start">
            See the other ways to start
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
