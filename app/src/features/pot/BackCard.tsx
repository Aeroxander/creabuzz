/**
 * Back this project: one amount and one button, then the sheet that shows exactly what happens. The door's state is said in
 * words when it is shut (and what to do), and an amount under the smallest says what the smallest is. Nothing is sent from
 * here: the sheet's press sends, with the sender the person chose.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { parseDollarAmount } from "../money/calls";
import type { ProjectNumbers } from "../money/numbers";
import { markBackAfterSignUp, takeBackAfterSignUp } from "./back-after-sign-up";
import { BackSheet } from "./BackSheet";
import { FaucetCard } from "./FaucetCard";
import { dollarsPhrase, doorShutWords } from "../money/copy";
import { targetOf } from "./target";
import { recordFitsBuild, type Ready, WalletGate } from "./use-pot";
import { useHolding } from "./YourShares";

function amountWords(
  reason: "empty" | "format" | "small",
  min: bigint,
): string {
  if (reason === "empty") return "Say how many dollars.";
  if (reason === "format") return "Write a number, like 25 or 25.50.";
  return `The smallest amount is ${dollarsPhrase(min)}.`;
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The Back box. `ready` is null for someone with no account yet: Back keeps the amount and goes to sign-up, which comes back
 * to this page; `ready` is set once they have one, and the amount they kept opens the sheet by itself.
 */
function BackForm({
  numbers,
  projectName,
  ready,
  holds = false,
  onSignUp,
}: {
  numbers: ProjectNumbers;
  projectName: string;
  ready: Ready | null;
  /** The account already holds Shares: Take out is the page's one primary press, so Back is the second. */
  holds?: boolean;
  onSignUp?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [amount, setAmount] = useState<bigint | null>(null);
  const min = numbers.limits.minJoin;
  const resumed = useRef(false);
  // An amount typed before signing up opens the sheet once the account is ready (it is used up the first time).
  useEffect(() => {
    if (!ready || resumed.current) return;
    resumed.current = true;
    const kept = takeBackAfterSignUp(sessionStore(), numbers.key);
    if (kept === null) return;
    setText(kept);
    const parsed = parseDollarAmount(kept, min);
    if (parsed.ok) setAmount(parsed.raw);
    else setProblem(amountWords(parsed.reason, min));
  }, [ready, min, numbers.key]);
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
          if (!ready) return onSignUp?.(text);
          setAmount(parsed.raw);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field
            autoComplete="off"
            data-testid="backing-amount"
            inputMode="decimal"
            label="How many dollars?"
            onChange={(event) => setText(event.target.value)}
            placeholder="25"
            problem={problem}
            value={text}
          />
        </div>
        {/* Level with the box: the height of the label above it (one line and its gap). */}
        <div className="shrink-0 pt-[1.625rem]">
          <Button
            data-testid="backing-review"
            type="submit"
            variant={holds ? "secondary" : "primary"}
          >
            Back
          </Button>
        </div>
      </form>
      {ready ? (
        <BackSheet
          amount={amount}
          numbers={numbers}
          onClose={() => {
            setAmount(null);
          }}
          projectName={projectName}
          ready={ready}
        />
      ) : null}
    </>
  );
}

/** The Back box for someone with no account: the same box, and Back is their way to sign up and come back to this amount. */
function SignedOutBack({
  numbers,
  projectName,
}: {
  numbers: ProjectNumbers;
  projectName: string;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <BackForm
      numbers={numbers}
      onSignUp={(text) => {
        markBackAfterSignUp(sessionStore(), numbers.key, text);
        void navigate({ to: "/welcome", search: { next: pathname } });
      }}
      projectName={projectName}
      ready={null}
    />
  );
}

/** The Back box for an account that is ready, with the faucet below it while the account has not taken its play dollars. */
function ReadyBack({
  numbers,
  projectName,
  ready,
}: {
  numbers: ProjectNumbers;
  projectName: string;
  ready: Ready;
}) {
  const target = targetOf(numbers);
  const holds = (useHolding(ready, target).data?.shares ?? 0n) > 0n;
  return (
    <>
      <BackForm
        holds={holds}
        numbers={numbers}
        projectName={projectName}
        ready={ready}
      />
      <FaucetCard ready={ready} target={target} />
    </>
  );
}

/** The Back box in the top of the page. */
export function BackCard({
  numbers,
  projectName,
  now,
}: {
  numbers: ProjectNumbers;
  projectName: string;
  now: number;
}) {
  const shut = doorShutWords(numbers, now);
  return (
    <Card
      aria-label="Back this project"
      className="flex flex-col gap-2 p-3"
      data-testid="backing-box"
      role="region"
    >
      {!recordFitsBuild(numbers) ? (
        <p className="text-sm" data-testid="back-wrong-contracts">
          Backing is off here: this app does not know this project's contracts.
          You can still take your money out.
        </p>
      ) : shut ? (
        <p className="text-sm" data-testid="back-door-shut">
          {shut} You can still take your money out from the Money tab.
        </p>
      ) : (
        <WalletGate
          chainId={numbers.chainId}
          signedOut={
            <SignedOutBack numbers={numbers} projectName={projectName} />
          }
          what="back this project"
        >
          {(ready) => (
            <ReadyBack
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
