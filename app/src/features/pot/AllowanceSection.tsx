/**
 * The allowance, for the people who run the project (the runner's own account, one of a Pair's two signers, or one of a
 * Council's seats): the box, its
 * ceiling, the rate, an announced raise and the weekly check-in's state with what happens if it lapses, in plain words and
 * with dates. The buttons open the sheets (`AllowanceSheets.tsx`). Everyone else sees the allowance in one sentence on the
 * page, not here.
 */
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { TeamPauseLine } from "../pause/TeamPauseLine";
import { useTeamPause } from "../pause/use-team-pause";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { dayText, type ProjectNumbers, timeText } from "../money/numbers";
import { potProblem } from "../money/pot-copy";
import {
  CHECK_IN_NO_RECORD,
  checkInFor,
  checkInRoute,
  runnerRole,
} from "../money/runner";
import { useMoneySend } from "../money/use-money";
import { checkInAction } from "../week/use-week";
import { AllowanceSheets, useAllowanceState } from "./AllowanceSheets";
import { RunnerAskNote } from "./RunnerAskNote";
import { checkInDoneWords } from "./runner-calls";
import { boxNow, rateWords, smallDollarsText, whenWords } from "./pot-words";
import { type Ready, WalletGate } from "./use-pot";

type Sheet = "draw" | "rate" | "door" | "apply";

function Row({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="num text-right" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** What happens if the weekly check-in lapses (or has), with the date. */
function lapseWords(lapseAt: number | null, now: number): string {
  if (lapseAt === null) return "";
  return lapseAt > now
    ? `If the team does not check in again by ${timeText(lapseAt)}, the box stops filling, new backing stops and Team Shares stop unlocking until it does.`
    : `The check-in is overdue (it was due ${timeText(lapseAt)}): the box has stopped filling, new backing is stopped and Team Shares have stopped unlocking until the team checks in.`;
}

/**
 * The weekly check-in's block: when the last one was, what a lapse does, and the press that keeps the project running.
 * The press lives beside the runner's other presses on purpose: after a hand-over the new runner did not start the
 * project, so the This-week page lists nothing for them and this is the only way back. A Pair's signer and a Council
 * seat press the same press; it then asks the others, and says so before and after.
 */
function CheckInBlock({
  a,
  lapseAt,
  numbers,
  now,
  ready,
  wound,
}: {
  a: { lastCheckIn: number };
  lapseAt: number | null;
  numbers: ProjectNumbers;
  now: number;
  ready: Ready;
  wound: boolean;
}) {
  const send = useMoneySend(
    checkInAction(numbers.chainId, numbers.contracts.treasury),
  );
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  // Either signer of a Pair checks in alone; only a Council's seat asks the other seats (and is told so).
  const route = checkInRoute(numbers, ready.address);
  return (
    <div data-testid="allowance-checkin">
      <h3 className="text-sm font-semibold">The weekly check-in</h3>
      <p className="mt-1 text-sm text-muted">
        {wound
          ? "This project has wound down, so there is nothing to check in."
          : `The last check-in was on ${a.lastCheckIn > 0 ? dayText(a.lastCheckIn) : "no day yet"}. ${lapseWords(lapseAt, now)} Backers can always take their money out.`}
      </p>
      {wound ? null : (
        <>
          <Link
            className="link mt-1 inline-flex min-h-11 items-center font-semibold"
            to="/week"
          >
            Go to this week
          </Link>
          {route !== null ? (
            <div className="mt-1 flex flex-col items-start gap-1.5">
              <Button
                data-testid="allowance-check-in"
                disabled={send.isPending}
                onClick={() => {
                  setProblem(null);
                  const call = checkInFor(
                    numbers,
                    ready.address,
                    CHECK_IN_NO_RECORD,
                  );
                  if (!call) return;
                  send.send(
                    { chainId: numbers.chainId, build: () => [call] },
                    {
                      onSuccess: () =>
                        toast(checkInDoneWords(route ?? "now"), "done"),
                      onError: (error) =>
                        setProblem(potProblem(error, "check-in")),
                    },
                  );
                }}
                size="sm"
                variant="secondary"
              >
                {send.waiting ? "Look for your check-in" : "Check in only"}
              </Button>
              {route === "ask" ? (
                <RunnerAskNote numbers={numbers} through="council" />
              ) : null}
            </div>
          ) : null}
          {problem ? (
            <p className="text-danger text-sm" role="alert">
              {problem}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Inner({
  numbers,
  ready,
  now,
}: {
  numbers: ProjectNumbers;
  ready: Ready;
  now: number;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // The state is read when the card shows, so the sentence beside each button is the chain's own.
  const state = useAllowanceState(numbers, ready, true);
  const pause = useTeamPause(numbers, ready.read);
  const pauseId = useId();
  const paused = pause?.stage === "paused";
  const role = runnerRole(numbers, ready.address);
  if (role.kind === "none") return null;
  if (state.isPending) return <Card className="h-24 animate-pulse" />;
  if (state.isError)
    return (
      <div className="flex flex-col gap-2" data-testid="allowance-read-failed">
        <p className="text-sm">
          The allowance could not be read from the network. Nothing changed.
        </p>
        <Button onClick={() => void state.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  const a = state.data;
  const box = boxNow(numbers, a.box, a.boxCap);
  const wound = numbers.windDown !== null;
  const due = a.pending !== null && a.pending.applicableAt <= now;
  const lapseAt = a.activeEnd > 0 ? a.activeEnd : null;
  return (
    <div className="flex flex-col gap-3">
      {role.kind === "signer" ? (
        <p className="text-sm text-muted" data-testid="allowance-pair">
          This project is run by two. Each step below asks the other signer, and
          happens when they confirm it.
        </p>
      ) : null}
      <dl className="divide-y divide-white/10">
        <Row
          label="In the allowance box, about"
          testId="allowance-box"
          value={`${smallDollarsText(box)} dollars`}
        />
        <Row
          label="The box holds at most"
          testId="allowance-cap"
          value={`${smallDollarsText(a.boxCap)} dollars`}
        />
        <Row
          label="The rate, of the project's money a day"
          testId="allowance-rate"
          value={rateWords(a.ratePpm)}
        />
        <Row
          label="The most the rate can be"
          testId="allowance-ceiling"
          value={rateWords(a.maxRatePpm)}
        />
      </dl>
      {a.pending ? (
        <p className="text-sm" data-testid="allowance-pending">
          A higher rate of {rateWords(a.pending.ratePpm)} a day was announced.{" "}
          {due
            ? "The wait is over: you can apply it."
            : `You can apply it from ${whenWords(a.pending.applicableAt)}.`}
        </p>
      ) : null}
      <CheckInBlock
        a={a}
        lapseAt={lapseAt}
        numbers={numbers}
        now={now}
        ready={ready}
        wound={wound}
      />
      {wound ? (
        <p className="text-sm text-muted">
          The allowance is closed: the box went back to the project's money.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <TeamPauseLine id={pauseId} pause={pause} />
          <Button
            aria-describedby={paused ? pauseId : undefined}
            block
            data-testid="allowance-draw"
            disabled={box === 0n || paused}
            onClick={() => setSheet("draw")}
          >
            Draw from the box
          </Button>
          <Button
            block
            data-testid="allowance-rate-open"
            onClick={() => setSheet("rate")}
            variant="secondary"
          >
            Change the rate
          </Button>
          {a.pending ? (
            <Button
              block
              data-testid="allowance-apply"
              onClick={() => setSheet("apply")}
              variant="secondary"
            >
              {due ? "Apply the announced rate" : "See the announced rate"}
            </Button>
          ) : null}
          <Button
            block
            data-testid="allowance-door"
            onClick={() => setSheet("door")}
            variant="secondary"
          >
            {numbers.door.switchOn ? "Close the door" : "Open the door"}
          </Button>
        </div>
      )}
      <AllowanceSheets
        now={now}
        numbers={numbers}
        onClose={() => setSheet(null)}
        ready={ready}
        sheet={sheet}
      />
    </div>
  );
}

/** The allowance card of the Money tab: only for the runner and a Pair's signers. */
export function AllowanceSection({
  numbers,
  address,
  now,
}: {
  numbers: ProjectNumbers;
  /** The account the sender shows, or null. */
  address: string | null;
  now: number;
}) {
  const titleId = useId();
  if (runnerRole(numbers, address).kind === "none") return null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="allowance-section"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        The allowance
      </h2>
      <WalletGate chainId={numbers.chainId} what="run the allowance">
        {(ready) => <Inner now={now} numbers={numbers} ready={ready} />}
      </WalletGate>
    </Card>
  );
}
