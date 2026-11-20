/**
 * Back this project: one amount and one button, then the sheet that shows exactly what happens. The door's state is said in
 * words when it is shut (and what to do), and an amount under the smallest says what the smallest is. Nothing is sent from
 * here: the sheet's press sends, with the sender the person chose.
 */
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { parseDollarAmount } from "../money/calls";
import type { ProjectNumbers } from "../money/numbers";
import { BackSheet } from "./BackSheet";
import { doorShutWords, smallDollarsText } from "./pot-words";
import { recordFitsBuild, type Ready, WalletGate } from "./use-pot";

function amountWords(
  reason: "empty" | "format" | "small",
  min: bigint,
): string {
  if (reason === "empty") return "Say how many dollars.";
  if (reason === "format")
    return "Write a number of dollars, like 25 or 25.50.";
  return `The smallest amount is ${smallDollarsText(min)} ${min === 1_000_000n ? "dollar" : "dollars"}.`;
}

function BackForm({
  numbers,
  projectName,
  ready,
}: {
  numbers: ProjectNumbers;
  projectName: string;
  ready: Ready;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [amount, setAmount] = useState<bigint | null>(null);
  const min = numbers.limits.minJoin;
  return (
    <>
      {/* The box and its press in one row, so Back is in the first screen of a phone. */}
      <form
        className="flex items-start gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseDollarAmount(text, min);
          if (!parsed.ok) return setProblem(amountWords(parsed.reason, min));
          setProblem(null);
          setAmount(parsed.raw);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field
            autoComplete="off"
            data-testid="backing-amount"
            hint={`From ${smallDollarsText(min)} ${min === 1_000_000n ? "dollar" : "dollars"}. There is no most.`}
            inputMode="decimal"
            label="How many dollars?"
            onChange={(event) => setText(event.target.value)}
            placeholder="For example: 25"
            problem={problem}
            value={text}
          />
        </div>
        {/* Level with the box: the height of the label above it (one line and its gap). */}
        <div className="shrink-0 pt-[1.625rem]">
          <Button data-testid="backing-review" type="submit">
            Back
          </Button>
        </div>
      </form>
      <BackSheet
        amount={amount}
        numbers={numbers}
        onClose={() => {
          setAmount(null);
        }}
        projectName={projectName}
        ready={ready}
      />
    </>
  );
}

/** The Back box on the Money tab. */
export function BackCard({
  numbers,
  projectName,
  now,
}: {
  numbers: ProjectNumbers;
  projectName: string;
  now: number;
}) {
  const titleId = useId();
  const shut = doorShutWords(numbers, now);
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-2 p-3"
      data-testid="backing-box"
      role="region"
    >
      <h2 className="headline text-lg" id={titleId}>
        Back this project
      </h2>
      {!recordFitsBuild(numbers) ? (
        <p className="text-sm" data-testid="back-wrong-contracts">
          This project's money is on contracts this version of the app does not
          know, so backing is off here. Nothing was sent. You can still take
          your money out below.
        </p>
      ) : shut ? (
        <div className="flex flex-col gap-2" data-testid="back-door-shut">
          <p className="text-sm">{shut}</p>
          <p className="text-sm text-muted">
            You can still take your money out below, whatever the door says.
          </p>
        </div>
      ) : (
        <WalletGate chainId={numbers.chainId} what="back this project">
          {(ready) => (
            <BackForm
              numbers={numbers}
              projectName={projectName}
              ready={ready}
            />
          )}
        </WalletGate>
      )}
    </Card>
  );
}
