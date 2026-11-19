import { useState } from "react";
import { Button } from "../../ui/button";
import type { ProjectNumbers } from "../money/numbers";
import { sharesText } from "../money/numbers";
import { SendSheet } from "./SendSheet";
import { asRunner, giveSharesData } from "./team-calls";
import type { PairState } from "./use-team";
import type { TeamWallet } from "./use-wallets";

const SHARE = 10n ** 18n;

/** The amounts Give Shares offers, as parts of all 1,000,000,000 Shares: nothing is typed. */
const GIFT_CHOICES = [
  { label: "100,000 Shares", detail: "0.01%", amount: 100_000n * SHARE },
  { label: "1,000,000 Shares", detail: "0.1%", amount: 1_000_000n * SHARE },
  { label: "10,000,000 Shares", detail: "1%", amount: 10_000_000n * SHARE },
] as const;

/** Whether a market has opened (Shares given after it are free at once, under the monthly limit). */
function afterMarket(numbers: ProjectNumbers): boolean {
  return numbers.stage.name === "council" || numbers.stage.name === "open";
}

/**
 * What the runner can do with one teammate, on that teammate's row of People: give them Shares (the runner, or either
 * signer of the Pair through a proposal). A teammate who has not linked a wallet is told so, since a gift needs an
 * address only they can prove.
 */
export function PersonTeamActions({
  numbers,
  name,
  wallet,
  me,
  pair,
}: {
  numbers: ProjectNumbers;
  name: string;
  wallet: TeamWallet | undefined;
  me: string | null;
  pair: PairState | null;
}) {
  const [open, setOpen] = useState(false);
  const treasury = numbers.contracts.treasury;
  if (!treasury || numbers.clock.woundDown) return null;
  if (!wallet) return null;
  if (wallet.state !== "linked")
    return (
      <p
        className="max-w-28 text-right text-xs text-muted"
        data-testid="no-wallet"
      >
        Has not linked a wallet yet
      </p>
    );
  const teammate = wallet.address;
  const gift = (amount: bigint) =>
    asRunner({
      runner: numbers.runner,
      pair,
      me,
      target: treasury,
      data: giveSharesData(teammate, amount),
    });
  // Never on one's own row: Shares for oneself are asked for by someone else.
  const canGive = teammate !== me?.toLowerCase() && gift(1n) !== null;
  if (!canGive) return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {canGive ? (
        <Button
          data-testid="give-shares"
          onClick={() => setOpen(true)}
          size="sm"
          variant="secondary"
        >
          Give Shares
        </Button>
      ) : null}
      {canGive ? (
        <GiveSheet
          gift={gift}
          name={name}
          numbers={numbers}
          onOpenChange={setOpen}
          open={open}
          teammate={teammate}
          treasury={treasury}
        />
      ) : null}
    </div>
  );
}

function GiveSheet({
  numbers,
  name,
  teammate,
  treasury,
  gift,
  open,
  onOpenChange,
}: {
  numbers: ProjectNumbers;
  name: string;
  teammate: string;
  treasury: string;
  gift: (amount: bigint) => ReturnType<typeof asRunner>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const picked = choice === null ? null : GIFT_CHOICES[choice];
  const plan = picked ? gift(picked.amount) : null;
  const market = afterMarket(numbers);
  // After a market all gifts together may be at most 1% of the Shares in people's hands in 30 days, and fewer than 1,000,000,000
  // are ever in hands: 10,000,000 is always refused then, so it is not offered.
  const choices = GIFT_CHOICES.map((c, index) => ({ ...c, index })).filter(
    (c) => !market || c.amount < 10_000_000n * SHARE,
  );
  return (
    <SendSheet
      // The Shares chosen are part of the step: a waiting gift of another amount is never taken for this one.
      action={`give:${numbers.chainId}:${treasury}:${teammate}:${picked?.amount ?? 0n}`}
      build={() => (plan ? [plan.call] : [])}
      chainId={numbers.chainId}
      confirmLabel={
        plan?.through === "pair" ? "Ask your co-signer to confirm" : "Give"
      }
      copy="give"
      disabled={!plan}
      done={
        plan?.through === "pair"
          ? "Asked. It happens when your co-signer confirms."
          : `Given to ${name}.`
      }
      onOpenChange={(next) => {
        if (!next) setChoice(null);
        onOpenChange(next);
      }}
      open={open}
      testId="give-sheet"
      title={`Give Shares to ${name}`}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm text-muted">
          From the project's work pot, for work done. Choose how many:
        </legend>
        {choices.map((c) => (
          <Button
            aria-pressed={choice === c.index}
            data-testid={`give-choice-${c.index}`}
            key={c.label}
            className={choice === c.index ? "ring-2 ring-mint" : undefined}
            onClick={() => setChoice(c.index)}
            variant="secondary"
          >
            {c.label} ({c.detail} of all Shares)
          </Button>
        ))}
      </fieldset>
      {picked ? (
        <ul
          className="flex list-disc flex-col gap-1.5 pl-5"
          data-testid="give-review"
        >
          <li>
            {sharesText(picked.amount)} Shares go to {name}'s linked wallet.
          </li>
          <li>
            {market
              ? "They are free at once. All gifts together may be at most 1% of the Shares in people's hands in any 30 days."
              : "They are held for them and released evenly over 365 days from the day a market opens; until then they cannot be sent or sold."}
          </li>
          {plan?.through === "pair" ? (
            <li>Your co-signer confirms it before anything moves.</li>
          ) : null}
        </ul>
      ) : null}
    </SendSheet>
  );
}
