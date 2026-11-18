import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { backCalls, backingSplit, parseDollars } from "./calls";
import { OwnershipLine, priceLine } from "./MoneyTab";
import { moneyProblem } from "./money-copy";
import {
  canLower,
  dollarsText,
  LOWER_WINDOW_SECONDS,
  type ProjectNumbers,
  type RoundNumbers,
  sharesText,
  timeText,
} from "./numbers";
import { readQuote, useMoneySend } from "./use-money";

const AMOUNT_WORDS = {
  empty: "Say how many dollars.",
  format: "Write a number of dollars, like 25 or 25.50.",
  small: "The smallest backing is 1 dollar.",
  large: "That is more than is left in this round.",
} as const;

/**
 * The Back box: one amount and Back, then a sheet that says what happens before anything is sent (the plan's budget:
 * 2 presses and 1 field). The wallet's own confirmations are the wallet's, not presses in this app.
 */
export function BackBox({
  projectName,
  numbers,
  round,
  primary,
  now,
}: {
  projectName: string;
  numbers: ProjectNumbers;
  round: RoundNumbers;
  primary: boolean;
  now: number;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [amount, setAmount] = useState<bigint | null>(null);
  const left = round.size > round.asked ? round.size - round.asked : 0n;
  const titleId = useId();

  const review = () => {
    const parsed = parseDollars(text, left > 0n ? left : undefined);
    if (!parsed.ok) {
      setProblem(AMOUNT_WORDS[parsed.reason]);
      return;
    }
    setProblem(null);
    setAmount(parsed.raw);
  };

  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="back-box"
      role="region"
    >
      <div>
        <h2 className="headline text-xl" id={titleId}>
          Back this project
        </h2>
        <p className="mt-1 text-sm text-muted">
          Round {round.round} is open until {timeText(round.closesAt)}.{" "}
          {priceLine(round)}.
        </p>
      </div>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          review();
        }}
      >
        <Field
          autoComplete="off"
          data-testid="back-amount"
          hint={`From 1 dollar. ${dollarsText(left)} dollars left in this round.`}
          inputMode="decimal"
          label="How many dollars?"
          onChange={(event) => setText(event.target.value)}
          placeholder="For example: 25"
          problem={problem}
          value={text}
        />
        <Button
          block
          data-testid="back-review"
          type="submit"
          variant={primary ? "primary" : "secondary"}
        >
          Back
        </Button>
      </form>
      <BackSheet
        amount={amount}
        numbers={numbers}
        now={now}
        onDone={() => {
          setAmount(null);
          setText("");
        }}
        projectName={projectName}
        round={round}
      />
    </Card>
  );
}

function BackSheet({
  amount,
  numbers,
  round,
  projectName,
  now,
  onDone,
}: {
  amount: bigint | null;
  numbers: ProjectNumbers;
  round: RoundNumbers;
  projectName: string;
  now: number;
  onDone: () => void;
}) {
  const send = useMoneySend();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const rounds = numbers.contracts.rounds;
  const value = amount ?? 0n;
  const split = backingSplit(value);
  const shares = value * round.sharesPerRawDollar;
  const lowerable = canLower(round, now);

  const confirm = () => {
    if (!rounds || amount === null) return;
    setProblem(null);
    send.mutate(
      {
        chainId: numbers.chainId,
        build: async (wallet) =>
          backCalls({
            quote: await readQuote(wallet, rounds),
            rounds,
            round: round.round,
            amount,
          }),
      },
      {
        onSuccess: () => {
          toast(
            "Backed. Your receipt shows on You once the round closes.",
            "done",
          );
          onDone();
        },
        onError: (error) => setProblem(moneyProblem(error, "back")),
      },
    );
  };

  return (
    <Sheet
      description="Nothing is sent until you say so here and in your wallet."
      onOpenChange={(open) => {
        if (!open && !send.isPending) {
          setProblem(null);
          onDone();
        }
      }}
      open={amount !== null}
      testId="back-sheet"
      title={`Back ${projectName} with ${dollarsText(value)} dollars`}
    >
      <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
        <li>
          You get about{" "}
          <span className="num font-semibold">{sharesText(shares)}</span>{" "}
          Shares, held for you. If more is asked than the round holds, everyone
          gets the same part and the rest comes back.
        </li>
        <li>
          Of your {dollarsText(value)}: {dollarsText(split.platform)} to the
          platform, {dollarsText(split.now)} to the project now, and{" "}
          {dollarsText(split.later)} released to it over 26 weeks while it
          checks in.
        </li>
        <li>
          Until it is released you can take your money back, less 5 of each 100.
          Taking it back cancels the Shares held for it.
        </li>
        <li>
          {lowerable
            ? `You can lower or withdraw this ask until ${timeText(round.opensAt + LOWER_WINDOW_SECONDS)}. After that it stays.`
            : "This round is past its first 12 hours, so this ask cannot be lowered or withdrawn once sent."}
        </li>
        <li>
          Your wallet asks twice: once to let the round take the dollars, once
          for the ask.
        </li>
      </ul>
      <OwnershipLine />
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="back-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="back-confirm"
        disabled={send.isPending || !rounds}
        onClick={confirm}
      >
        {send.isPending
          ? "Waiting for your wallet…"
          : `Back with ${dollarsText(value)} dollars`}
      </Button>
    </Sheet>
  );
}
