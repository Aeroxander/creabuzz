import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { freshnessLine } from "@creaton/core/project/weekly-update.ts";
import { Link } from "@tanstack/react-router";
import { CalendarCheck, PenLine } from "lucide-react";
import { useState } from "react";
import { ScreenHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { investingOn } from "../../lib/server";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import { useToast } from "../../ui/toast";
import { checkInCall } from "../money/calls";
import { moneyProblem } from "../money/money-copy";
import { dayText, isRunner, type ProjectNumbers } from "../money/numbers";
import {
  useMoneySend,
  useProjectNumbers,
  useWalletAddress,
} from "../money/use-money";
import { useProjectsBy } from "../profile/use-own-projects";
import { type Project, projectRef } from "../project/project-record";
import { checkInAction, useLastWeekly } from "./use-week";
import { WeeklySheet } from "./WeeklySheet";

/**
 * This week: the founder's ten minutes. Each project has one press to open the update, one box, and one press to post
 * it (and, where the server reads the project's launch and this wallet runs it, to check in on the network as well).
 */
export function WeekPage() {
  const { pubkey } = useAccount();
  const projects = useProjectsBy(pubkey);
  const last = useLastWeekly(pubkey, projects.data ?? []);
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="week-page"
    >
      <ScreenHeader title="This week" />
      <p className="-mt-2 text-muted">
        Ten minutes a week: say what you did, and check in.
      </p>
      {!pubkey || (projects.data && projects.data.length === 0) ? (
        <EmptyState
          action={<ButtonLink to="/start">Start a project</ButtonLink>}
          icon={<CalendarCheck size={28} />}
          title="Nothing to do yet"
        >
          Start a project and your week shows here.
        </EmptyState>
      ) : projects.isPending ? (
        <Card className="h-28 animate-pulse" />
      ) : (
        (projects.data ?? []).map((project) => (
          <WeekCard
            key={project.coordinate}
            lastUpdate={last.data?.get(project.coordinate) ?? null}
            lastKnown={last.isSuccess}
            project={project}
          />
        ))
      )}
    </main>
  );
}

function WeekCard({
  project,
  lastUpdate,
  lastKnown,
}: {
  project: Project;
  lastUpdate: number | null;
  lastKnown: boolean;
}) {
  const [open, setOpen] = useState(false);
  const investing = investingOn();
  const numbersRead = useProjectNumbers(investing ? project : null);
  const numbers =
    investing && numbersRead.data && !numbersRead.data.removed
      ? numbersRead.data
      : null;
  const address = useWalletAddress().data ?? null;
  const checkIn = numbers ? checkInFor(numbers, address) : null;
  const now = Math.floor(Date.now() / 1000);
  return (
    <Card className="flex flex-col gap-3" data-testid="week-project">
      <div className="flex items-baseline justify-between gap-3">
        <Link
          className="headline text-xl hover:underline"
          params={{ ref: projectRef(project) }}
          to="/p/$ref"
        >
          {project.name}
        </Link>
        <span className="text-xs text-muted">
          started {relativeTime(project.startedAt)}
        </span>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {lastKnown ? (
          <li data-testid="week-last-update">
            {freshnessLine(lastUpdate, now)}
          </li>
        ) : null}
        {numbers ? <ClockLine numbers={numbers} /> : null}
      </ul>
      <Button
        data-testid="week-open"
        onClick={() => setOpen(true)}
        size="sm"
        variant="secondary"
      >
        <PenLine aria-hidden="true" size={16} />
        {checkIn
          ? "Post this week's update and check in"
          : "Post this week's update"}
      </Button>
      {numbers && checkIn ? (
        <CheckInAgain numbers={numbers} treasury={checkIn} />
      ) : null}
      <WeeklySheet
        checkIn={numbers && checkIn ? { numbers, treasury: checkIn } : null}
        onOpenChange={setOpen}
        open={open}
        project={project}
      />
    </Card>
  );
}

/** The project's Treasury when this wallet runs the project and can check in on the network, else null. */
function checkInFor(numbers: ProjectNumbers, address: string | null) {
  const treasury = numbers.contracts.treasury;
  if (!treasury || numbers.clock.woundDown) return null;
  return isRunner(numbers, address) ? treasury : null;
}

function ClockLine({ numbers }: { numbers: ProjectNumbers }) {
  if (numbers.clock.woundDown)
    return (
      <li className="text-muted">Wound down: payments stopped for good.</li>
    );
  if (numbers.now.quietSince)
    return (
      <li data-testid="week-clock">
        Quiet since {dayText(numbers.now.quietSince)}: payments wait for your
        next check-in.
      </li>
    );
  if (numbers.clock.lastCheckIn)
    return (
      <li data-testid="week-clock">
        Last check-in {dayText(numbers.clock.lastCheckIn)}. Payments run until{" "}
        {numbers.clock.runsUntil
          ? dayText(numbers.clock.runsUntil)
          : "your next check-in"}
        .
      </li>
    );
  return <li data-testid="week-clock">No check-in yet.</li>;
}

/**
 * Check in without posting: for the week whose update went out but whose check-in did not. The network's own record of
 * the last check-in (above) is what says whether it is still needed; nothing here pretends it happened.
 */
function CheckInAgain({
  numbers,
  treasury,
}: {
  numbers: ProjectNumbers;
  treasury: string;
}) {
  const send = useMoneySend(checkInAction(numbers.chainId, treasury));
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      <Button
        data-testid="week-check-in-only"
        disabled={send.isPending}
        onClick={() => {
          setProblem(null);
          send.send(
            { chainId: numbers.chainId, build: () => [checkInCall(treasury)] },
            {
              onSuccess: () =>
                toast("Checked in. Payments run for 14 more days.", "done"),
              onError: (error) => setProblem(moneyProblem(error, "check-in")),
            },
          );
        }}
        size="sm"
        variant="ghost"
      >
        {send.waiting ? "Look for your check-in" : "Check in only"}
      </Button>
    </>
  );
}
