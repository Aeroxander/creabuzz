import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { backCalls, backingSplit, mostBack, parseDollars } from "./calls";
import { OwnershipLine, priceLine } from "./MoneyTab";
import { moneyProblem } from "./money-copy";
import {
  canLower,
  dollarsText,
  LOWER_WINDOW_SECONDS,
  type ProjectNumbers,
  type RoundNumbers,
  sharesPerDollar,
  sharesText,
  timeText,
} from "./numbers";
import { readQuote, useMoneySend } from "./use-money";

const AMOUNT_WORDS = {
  empty: "Say how many dollars.",
  format: "Write a number of dollars, like 25 or 25.50.",
  small: "The smallest backing is 1 dollar.",
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
  const titleId = useId();
  // Earlier rounds at another price are named here, where money is offered, not only on the Money tab.
  const otherPrices = numbers.rounds.filter(
    (r) =>
      r.round < round.round &&
      r.sharesPerRawDollar !== round.sharesPerRawDollar,
  );

  const review = () => {
    // More than the round holds may be asked: then everyone gets the same part and the rest comes back.
    const parsed = parseDollars(text);
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
        {otherPrices.length > 0 ? (
          <p
            className="mt-1 text-sm text-muted"
            data-testid="back-other-prices"
          >
            {otherPrices
              .map(
                (r) =>
                  `Round ${r.round} was priced at ${sharesPerDollar(r.sharesPerRawDollar)} Shares a dollar.`,
              )
              .join(" ")}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-muted" data-testid="back-asked">
          <span className="num">{dollarsText(round.asked)}</span> dollars asked
          so far by {round.backers} {round.backers === 1 ? "backer" : "backers"}
          , of <span className="num">{dollarsText(round.size)}</span> this round
          holds.
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
          hint={`From 1 dollar. The round takes up to ${dollarsText(round.size)} dollars in all.`}
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
  const rounds = numbers.contracts.rounds;
  const send = useMoneySend(
    `back:${numbers.chainId}:${rounds ?? ""}:${round.round}`,
  );
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const value = amount ?? 0n;
  const split = backingSplit(value);
  const asked = round.asked + value;
  // When more is asked than the round holds, every ask gets the same part: the size over everything asked.
  const over = asked > round.size && asked > 0n;
  const shares = over
    ? (value * round.sharesPerRawDollar * round.size) / asked
    : value * round.sharesPerRawDollar;
  const per100 = over ? (round.size * 100n) / asked : 100n;
  const lowerable = canLower(round, now);

  const confirm = () => {
    if (!rounds || amount === null) return;
    setProblem(null);
    send.send(
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
          Shares, held for you.{" "}
          {over
            ? `More is asked than the round holds (${dollarsText(asked)} dollars with yours, of ${dollarsText(round.size)}), so each ask gets about ${per100} of each 100 and the rest comes back.`
            : "If more is asked than the round holds, everyone gets the same part and the rest comes back."}
        </li>
        <li>
          Of your {dollarsText(value)}: {dollarsText(split.platform)} to the
          platform, {dollarsText(split.now)} to the project now, and{" "}
          {dollarsText(split.later)} released to it over 26 weeks while it
          checks in.
        </li>
        <li>
          At most {dollarsText(mostBack(value))} of your {dollarsText(value)}{" "}
          can come back (77.90 of each 100): the part not yet released, less 5
          of each 100 of it. It falls as the money is released over 26 weeks of
          check-ins, to nothing. Taking money back cancels the Shares held for
          it.
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
          : send.waiting
            ? "Look for your backing"
            : `Back with ${dollarsText(value)} dollars`}
      </Button>
    </Sheet>
  );
}
