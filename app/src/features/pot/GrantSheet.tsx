/**
 * Grant Team Shares: from the Team pool, to one person, each grant on its own clock. The sheet says what the grant is and
 * is not (Team Shares claim only the project's money above what backers put in, and unlock with active time), and the call it
 * sends is exactly the member and the amount shown on it. With a Pair as runner it is a proposal the other signer confirms.
 */
import { grantTeamCall } from "@creaton/core/pot/pot-calls.ts";
import { useState } from "react";
import { Field } from "../../ui/field";
import { dayText, type ProjectNumbers } from "../money/numbers";
import { PotSheet } from "./PotSheet";
import { PAIR_WORDS, doneWords, runnerSend } from "./runner-calls";
import { sharesWords } from "../money/copy";
import type { Ready } from "./use-pot";

const SHARE = 1_000_000_000_000_000_000n;

/** Whole or decimal Shares typed by a person, as raw units (up to 18 decimals); null when it is not a number. */
export function parseShares(text: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{0,18}))?$/.exec(text.trim().replace(/,/g, ""));
  if (!m) return null;
  return (
    BigInt(m[1] ?? "0") * SHARE + BigInt((m[2] ?? "").padEnd(18, "0") || "0")
  );
}

/** A team member a grant can go to: an account of theirs that the person proved is theirs. */
export interface GrantMember {
  pubkey: string;
  name: string;
  /** The wallet they linked, or null when none (then they cannot be granted to here). */
  address: string | null;
}

/** Days for a count of time units, "about 13 weeks" style: units are weeks on a real network. */
function unitsWords(units: number, unit: number): string {
  const days = Math.round((units * unit) / 86_400);
  return `about ${days} ${days === 1 ? "day" : "days"}`;
}

export function GrantSheet({
  numbers,
  ready,
  members,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  ready: Ready;
  members: GrantMember[];
  open: boolean;
  onClose: () => void;
}) {
  const [who, setWho] = useState("");
  const [text, setText] = useState("");
  const member = members.find((m) => m.pubkey === who && m.address);
  const amount = parseShares(text);
  const { minGrant, cliffUnits, vestUnits } = numbers.limits;
  const left = numbers.team.ungranted;
  const problem =
    text.trim() === ""
      ? null
      : amount === null
        ? "Write a number of Team Shares, like 1,000."
        : amount < minGrant
          ? `The smallest grant is ${sharesWords(minGrant)} Team Share${minGrant === 1_000_000_000_000_000_000n ? "" : "s"}.`
          : amount > left
            ? `Only about ${sharesWords(left)} Team Shares are left in the pool.`
            : null;
  const inner =
    member?.address && amount !== null && !problem
      ? grantTeamCall({
          treasury: numbers.contracts.treasury,
          member: member.address,
          amount,
        })
      : null;
  const send = inner ? runnerSend(numbers, ready.address, inner) : null;
  return (
    <PotSheet
      account={ready.address}
      action={`grant:${numbers.chainId}:${numbers.contracts.treasury}`}
      blocked={!send}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={
        member && amount !== null && !problem
          ? `Grant ${sharesWords(amount)} Team Shares to ${member.name}`
          : "Grant Team Shares"
      }
      done={doneWords(
        send?.through ?? "alone",
        "Granted. Its clock has started.",
      )}
      lookLabel="Look for your grant"
      onOpenChange={(next) => {
        if (!next) {
          setWho("");
          setText("");
          onClose();
        }
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="grant"
      testId="grant-sheet"
      title="Grant Team Shares"
    >
      <p className="text-sm" data-testid="grant-pool">
        {sharesWords(left)} of {sharesWords(numbers.team.pool)} left to grant.
      </p>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-semibold" htmlFor="grant-member">
          Grant to
        </label>
        <select
          className="field glass"
          data-testid="grant-member"
          id="grant-member"
          onChange={(e) => setWho(e.target.value)}
          value={who}
        >
          <option value="">Choose someone on the team</option>
          {members.map((m) => (
            <option disabled={!m.address} key={m.pubkey} value={m.pubkey}>
              {m.address ? m.name : `${m.name} (has not linked an account)`}
            </option>
          ))}
        </select>
      </div>
      <Field
        autoComplete="off"
        data-testid="grant-amount"
        hint={`At least ${sharesWords(minGrant)}.`}
        inputMode="decimal"
        label="How many Team Shares?"
        onChange={(e) => setText(e.target.value)}
        placeholder="For example: 1,000"
        problem={problem}
        value={text}
      />
      <ul
        className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted"
        data-testid="grant-clock"
      >
        <li>
          Each grant has its own clock. Nothing unlocks for{" "}
          {unitsWords(cliffUnits, numbers.unit)}; then it unlocks a little each
          day, for {unitsWords(vestUnits, numbers.unit)} in all.
        </li>
        <li>Team Shares pay only what is above what backers put in.</li>
      </ul>
      {member?.address && amount !== null && !problem ? (
        <p className="text-sm" data-testid="grant-terms">
          {sharesWords(amount)} Team Shares go to {member.name} (
          {member.address}), starting {dayText(Math.floor(Date.now() / 1000))}.
        </p>
      ) : null}
      {send?.through === "pair" ? (
        <p className="text-sm text-muted">{PAIR_WORDS}</p>
      ) : null}
    </PotSheet>
  );
}
