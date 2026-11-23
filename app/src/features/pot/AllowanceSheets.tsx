/**
 * The runner's sheets for the allowance: draw to an address, change the rate (lower at once, or announce a raise and apply
 * it after the wait), apply an announced raise, open or close the door. Each shows what it does in plain words and the
 * numbers it read from the chain when it opened, and the call it sends is made from exactly what is on the sheet. With a
 * Pair as runner each is a proposal the other signer confirms.
 */
import {
  applyRateCall,
  drawCall,
  proposeRateCall,
  setDoorCall,
  setRateCall,
} from "@creaton/core/pot/pot-calls.ts";
import {
  type AllowanceState,
  readAllowanceState,
} from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { parseDollarAmount } from "../money/calls";
import { dollarsPhrase } from "../money/pot-copy-tasks";
import { dayText, type ProjectNumbers, timeText } from "../money/numbers";
import { TeamPauseLine } from "../pause/TeamPauseLine";
import { useTeamPause } from "../pause/use-team-pause";
import { alreadyAsked } from "./asked-already";
import { PotSheet } from "./PotSheet";
import { RunnerAskNote } from "./RunnerAskNote";
import { doneWords, runnerSend } from "./runner-calls";
import {
  alreadyAskedUnknownWords,
  alreadyAskedWords,
  boxNow,
  rateWords,
  smallDollarsText,
} from "./pot-words";
import type { Ready } from "./use-pot";

/** The allowance as the chain has it now, read when a sheet opens. */
export function useAllowanceState(
  numbers: ProjectNumbers,
  ready: Ready,
  enabled: boolean,
) {
  return useQuery<AllowanceState>({
    queryKey: ["pot", "allowance", numbers.contracts.treasury],
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readAllowanceState(ready.read, numbers.contracts.treasury),
  });
}

type Sheet = "draw" | "rate" | "door" | "apply";

interface Props {
  numbers: ProjectNumbers;
  ready: Ready;
  sheet: Sheet | null;
  onClose: () => void;
  now: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function Failed({ retry }: { retry: () => void }) {
  return (
    <div className="flex flex-col gap-2" data-testid="allowance-read-failed">
      <p className="text-sm">
        The allowance could not be read from the network, so nothing can be sent
        now. Nothing changed.
      </p>
      <Button onClick={retry} variant="secondary">
        Try again
      </Button>
    </div>
  );
}

function DrawSheet({ numbers, ready, sheet, onClose }: Props) {
  const open = sheet === "draw";
  const pause = useTeamPause(numbers, ready.read, open);
  const paused = pause?.stage === "paused";
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const state = useAllowanceState(numbers, ready, open);
  const parsed = parseDollarAmount(text, 1n);
  const target = to.trim().toLowerCase();
  const box = state.data
    ? boxNow(numbers, state.data.box, state.data.boxCap)
    : 0n;
  const toProblem =
    to.trim() === ""
      ? null
      : !ADDRESS.test(to.trim())
        ? "That is not an account address. It starts with 0x and has 42 characters."
        : null;
  const amountProblem =
    text.trim() === ""
      ? null
      : !parsed.ok
        ? "Write a number of dollars, like 25 or 25.50."
        : state.data && parsed.raw > box
          ? `The box holds about ${smallDollarsText(box)} dollars now. Draw that or less.`
          : null;
  const ok =
    ADDRESS.test(target) &&
    parsed.ok &&
    state.data !== undefined &&
    parsed.raw <= box &&
    parsed.raw > 0n;
  const send =
    ok && parsed.ok
      ? runnerSend(
          numbers,
          ready.address,
          drawCall({
            treasury: numbers.contracts.treasury,
            to: target,
            amount: parsed.raw,
          }),
        )
      : null;
  // A Pair's and a Council's proposals each get their own id, so a second identical ask would run the step twice:
  // what already waits is read before anything is sent (the words are pot-words').
  const askedThrough = send && send.through !== "alone" ? send.through : null;
  const askedAgain =
    askedThrough && parsed.ok
      ? async () => {
          const inner = drawCall({
            treasury: numbers.contracts.treasury,
            to: target,
            amount: parsed.raw,
          });
          try {
            return (await alreadyAsked(ready, numbers, askedThrough, inner))
              ? alreadyAskedWords(askedThrough, "draw")
              : null;
          } catch {
            return alreadyAskedUnknownWords(askedThrough);
          }
        }
      : undefined;
  return (
    <PotSheet
      account={ready.address}
      action={`draw:${numbers.chainId}:${numbers.contracts.treasury}`}
      blocked={!send || paused}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={
        send && parsed.ok
          ? `Draw ${smallDollarsText(parsed.raw)} dollars`
          : "Draw"
      }
      description="Take money from the allowance box"
      done={doneWords(
        send?.through ?? "alone",
        "Drawn from the allowance box.",
      )}
      lookLabel="Look for your draw"
      onOpenChange={(next) => {
        if (!next) {
          setTo("");
          setText("");
          onClose();
        }
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="draw"
      recheck={askedAgain}
      testId="draw-sheet"
      title="Draw from the allowance box"
    >
      {state.isPending ? (
        <Card className="h-20 animate-pulse" />
      ) : state.isError ? (
        <Failed retry={() => void state.refetch()} />
      ) : (
        <>
          <TeamPauseLine pause={pause} />
          <p className="text-sm" data-testid="draw-box">
            The box holds about {smallDollarsText(box)} dollars now. You can
            draw up to that, to an account of your choice.
          </p>
          <Field
            autoComplete="off"
            data-testid="draw-to"
            hint="The account that gets the dollars."
            label="Draw to which account?"
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x…"
            problem={toProblem}
            value={to}
          />
          <Field
            autoComplete="off"
            data-testid="draw-amount"
            inputMode="decimal"
            label="How many dollars?"
            onChange={(e) => setText(e.target.value)}
            placeholder="For example: 25"
            problem={amountProblem}
            value={text}
          />
          {send && parsed.ok ? (
            <p className="text-sm" data-testid="draw-terms">
              {dollarsPhrase(parsed.raw)}{" "}
              {smallDollarsText(parsed.raw) === "1" ? "goes" : "go"} from the
              box to {target}.
            </p>
          ) : null}
          <RunnerAskNote numbers={numbers} through={send?.through} />
        </>
      )}
    </PotSheet>
  );
}

/** A percent a day typed by a person, as parts per million: "0.10" is 1000. Null when it is not a rate. */
export function parseRate(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{0,4}))?$/.exec(text.trim().replace(/%$/, ""));
  if (!m) return null;
  return Number(m[1]) * 10_000 + Number((m[2] ?? "").padEnd(4, "0") || "0");
}

function RateSheet({ numbers, ready, sheet, onClose }: Props) {
  const open = sheet === "rate";
  const [text, setText] = useState("");
  const state = useAllowanceState(numbers, ready, open);
  const ppm = parseRate(text);
  const max = state.data?.maxRatePpm ?? numbers.limits.maxRatePpm;
  const current = state.data?.ratePpm ?? numbers.allowance.ratePpm;
  const raise = ppm !== null && ppm > current;
  const problem =
    text.trim() === ""
      ? null
      : ppm === null
        ? "Write a rate like 0.10 for a tenth of a percent a day."
        : ppm > max
          ? `The most allowed is ${rateWords(max)} a day.`
          : ppm === current
            ? "That is the rate now."
            : null;
  const inner =
    ppm !== null && ppm <= max && ppm !== current
      ? raise
        ? proposeRateCall(numbers.contracts.treasury, ppm)
        : setRateCall(numbers.contracts.treasury, ppm)
      : null;
  const send = inner ? runnerSend(numbers, ready.address, inner) : null;
  return (
    <PotSheet
      account={ready.address}
      action={`rate:${numbers.chainId}:${numbers.contracts.treasury}`}
      blocked={!send}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={
        ppm === null
          ? "Change the allowance"
          : raise
            ? `Announce ${rateWords(ppm)} a day`
            : `Lower it to ${rateWords(ppm)} a day`
      }
      description="Change the daily allowance"
      done={doneWords(
        send?.through ?? "alone",
        raise
          ? "Announced. You can apply it after the wait."
          : "The allowance is lowered.",
      )}
      lookLabel="Look for your change"
      onOpenChange={(next) => {
        if (!next) {
          setText("");
          onClose();
        }
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="rate"
      testId="rate-sheet"
      title="Change the daily allowance"
    >
      {state.isPending ? (
        <Card className="h-20 animate-pulse" />
      ) : state.isError ? (
        <Failed retry={() => void state.refetch()} />
      ) : (
        <>
          <p className="text-sm" data-testid="rate-now">
            The allowance is {rateWords(current)} of the project's money a day
            now. The most allowed is {rateWords(max)}.
          </p>
          <Field
            autoComplete="off"
            data-testid="rate-new"
            hint="Percent of the project's money a day, like 0.10."
            inputMode="decimal"
            label="New rate"
            onChange={(e) => setText(e.target.value)}
            placeholder="For example: 0.05"
            problem={problem}
            value={text}
          />
          {ppm !== null && !problem ? (
            <p className="text-sm" data-testid="rate-terms">
              {raise
                ? `A higher rate is announced first, so everyone can see it. It can be applied ${weekWords(numbers)} after you announce it.`
                : "A lower rate takes effect at once."}
            </p>
          ) : null}
          <RunnerAskNote numbers={numbers} through={send?.through} />
        </>
      )}
    </PotSheet>
  );
}

/** The wait before a raise: one time unit, in days. */
function weekWords(numbers: ProjectNumbers): string {
  const days = Math.round(numbers.unit / 86_400);
  return days >= 1 ? `${days} ${days === 1 ? "day" : "days"}` : "a short while";
}

function ApplySheet({ numbers, ready, sheet, onClose, now }: Props) {
  const open = sheet === "apply";
  const state = useAllowanceState(numbers, ready, open);
  const pending = state.data?.pending ?? null;
  const due = pending !== null && pending.applicableAt <= now;
  const send = due
    ? runnerSend(
        numbers,
        ready.address,
        applyRateCall(numbers.contracts.treasury),
      )
    : null;
  return (
    <PotSheet
      account={ready.address}
      action={`apply-rate:${numbers.chainId}:${numbers.contracts.treasury}`}
      blocked={!send}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={
        pending ? `Apply ${rateWords(pending.ratePpm)} a day` : "Apply"
      }
      description="Apply the announced allowance"
      done={doneWords(
        send?.through ?? "alone",
        "The new allowance is in place.",
      )}
      lookLabel="Look for your change"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="rate"
      testId="apply-sheet"
      title="Apply the announced allowance"
    >
      {state.isPending ? (
        <Card className="h-20 animate-pulse" />
      ) : state.isError ? (
        <Failed retry={() => void state.refetch()} />
      ) : pending === null ? (
        <p className="text-sm" data-testid="apply-none">
          No higher allowance is announced now.
        </p>
      ) : due ? (
        <p className="text-sm" data-testid="apply-ready">
          The wait is over. Applying sets the allowance to{" "}
          {rateWords(pending.ratePpm)} of the project's money a day.
        </p>
      ) : (
        <p className="text-sm" data-testid="apply-wait">
          {rateWords(pending.ratePpm)} a day was announced. It can be applied
          from {timeText(pending.applicableAt)}.
        </p>
      )}
    </PotSheet>
  );
}

function DoorSheet({ numbers, ready, sheet, onClose }: Props) {
  const open = sheet === "door";
  const shutting = numbers.door.switchOn;
  const send = runnerSend(
    numbers,
    ready.address,
    setDoorCall(numbers.contracts.treasury, !shutting),
  );
  return (
    <PotSheet
      account={ready.address}
      action={`door:${numbers.chainId}:${numbers.contracts.treasury}`}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={shutting ? "Close the door" : "Open the door"}
      description="The door to new backing"
      done={doneWords(
        send?.through ?? "alone",
        shutting ? "The door is closed." : "The door is open.",
      )}
      lookLabel="Look for your change"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="door"
      testId="door-sheet"
      title={
        shutting
          ? "Close the door to new backing?"
          : "Open the door to new backing?"
      }
    >
      <p className="text-sm" data-testid="door-words">
        {shutting
          ? "While the door is closed nobody can back this project. People who hold Shares can still take their money out."
          : `Opening it lets anyone back this project again, as long as the team keeps checking in${numbers.clock.activeUntil ? ` (the next check-in is due by ${dayText(numbers.clock.activeUntil)})` : ""}.`}
      </p>
      <RunnerAskNote numbers={numbers} through={send?.through} />
    </PotSheet>
  );
}

/** All four sheets; the one named by `sheet` is open. */
export function AllowanceSheets(props: Props) {
  return (
    <>
      <DrawSheet {...props} />
      <RateSheet {...props} />
      <ApplySheet {...props} />
      <DoorSheet {...props} />
    </>
  );
}
