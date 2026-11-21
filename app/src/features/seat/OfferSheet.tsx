/**
 * Offer the seat that runs the project's money: to one person to take over ("hand over"), or to one person to run it together
 * with ("make a Pair"). The person is chosen from the team (one who linked a wallet), and what the offer does and does not do
 * is said before the press. The call sent is exactly the person and the choice on the sheet; for a pair the address is the one
 * the Launcher gives for the two of them. With a Pair as runner a hand-over is a proposal the other signer confirms.
 */
import { handOverCall } from "@creaton/core/pot/pot-calls.ts";
import { pairAddressOf, readSeatState } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import type { GrantMember } from "../pot/GrantSheet";
import { PotSheet } from "../pot/PotSheet";
import { PAIR_WORDS, doneWords, runnerSend } from "../pot/runner-calls";
import type { Ready } from "../pot/use-pot";
import { spanOf } from "../launch/launch-terms";
import {
  FOUNDER_LEAVES_WORDS,
  handOverWords,
  pairOfferWords,
} from "./seat-words";

export type OfferMode = "hand-over" | "pair";

interface Props {
  mode: OfferMode;
  numbers: ProjectNumbers;
  ready: Ready;
  members: GrantMember[];
  open: boolean;
  onClose: () => void;
}

const TITLES: Record<OfferMode, string> = {
  "hand-over": "Hand over the seat",
  pair: "Run it together",
};

export function OfferSheet({
  mode,
  numbers,
  ready,
  members,
  open,
  onClose,
}: Props) {
  const [who, setWho] = useState("");
  const [leaves, setLeaves] = useState(false);
  const runner = numbers.runner.address;
  const me = ready.address.toLowerCase();
  const isFounder = me === numbers.founder;
  const signers: readonly string[] = numbers.runner.signers ?? [];
  // Not the person who runs it now (the contract refuses an offer to the runner), and for a hand-over from a pair, not a signer.
  const choices = members.filter(
    (m) =>
      !m.address ||
      (m.address !== me &&
        m.address !== runner &&
        !signers.includes(m.address)),
  );
  const member = choices.find((m) => m.pubkey === who && m.address);
  const address = member?.address ?? null;
  // The address of the pair the two would make (the Launcher works it out).
  const pair = useQuery({
    queryKey: ["pot", "pair-address", numbers.key, runner, address ?? ""],
    enabled: open && mode === "pair" && address !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      pairAddressOf(
        ready.read,
        numbers.launcher,
        numbers.key,
        runner,
        address ?? "",
      ),
  });
  const next = mode === "pair" ? (pair.data ?? null) : address;
  // Leaving the project is the founder's own word, for a hand-over only.
  const founderLeaves = mode === "hand-over" && isFounder && leaves;
  const inner =
    next && member
      ? handOverCall({
          treasury: numbers.contracts.treasury,
          next,
          founderLeaves,
        })
      : null;
  const send = inner ? runnerSend(numbers, ready.address, inner) : null;
  const lasts = useQuery({
    queryKey: ["pot", "seat-lasts", numbers.contracts.treasury],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      (await readSeatState(ready.read, numbers.contracts.treasury)).offerLasts,
  });
  const through = send?.through ?? "alone";
  return (
    <PotSheet
      account={ready.address}
      action={`seat-offer:${mode}:${numbers.chainId}:${numbers.contracts.treasury}`}
      blocked={!send || lasts.isPending}
      calls={send?.calls ?? null}
      chainId={numbers.chainId}
      confirmLabel={
        member
          ? mode === "pair"
            ? `Ask ${member.name} to run it with you`
            : `Offer the seat to ${member.name}`
          : TITLES[mode]
      }
      description={
        mode === "pair"
          ? "Ask one person to run the project's money with you"
          : "Offer the seat that runs the project's money to one person"
      }
      detail={next ? `to:${next}` : undefined}
      done={doneWords(
        through,
        mode === "pair"
          ? "Asked. They can accept the second seat now."
          : "Offered. They can take the seat now.",
      )}
      landed={
        through === "alone" && next
          ? async (wallet) =>
              (
                await readSeatState(
                  (to, data) => wallet.readCall(to, data),
                  numbers.contracts.treasury,
                )
              ).offeredTo === next
          : undefined
      }
      lookLabel="Look for your offer"
      onOpenChange={(value) => {
        if (!value) {
          setWho("");
          setLeaves(false);
          onClose();
        }
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="seat"
      testId="offer-sheet"
      title={TITLES[mode]}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-semibold" htmlFor="offer-member">
          {mode === "pair" ? "Who runs it with you?" : "Hand it to"}
        </label>
        <select
          className="field glass"
          data-testid="offer-member"
          id="offer-member"
          onChange={(e) => setWho(e.target.value)}
          value={who}
        >
          <option value="">Choose someone on the team</option>
          {choices.map((m) => (
            <option disabled={!m.address} key={m.pubkey} value={m.pubkey}>
              {m.address ? m.name : `${m.name} (has not linked an account)`}
            </option>
          ))}
        </select>
      </div>
      {mode === "pair" && address && pair.isPending ? (
        <Card className="h-10 animate-pulse" />
      ) : null}
      {mode === "pair" && address && pair.isError ? (
        <p className="text-sm" data-testid="offer-read-failed" role="alert">
          The network could not work out the address for the two of you, so
          nothing can be sent now. Nothing changed. Choose the person again to
          try again.
        </p>
      ) : null}
      {mode === "hand-over" && isFounder ? (
        <label className="flex items-start gap-2.5 text-sm">
          <input
            checked={leaves}
            className="mt-1 size-5 shrink-0"
            data-testid="offer-leaves"
            onChange={(e) => setLeaves(e.target.checked)}
            type="checkbox"
          />
          <span>{FOUNDER_LEAVES_WORDS}</span>
        </label>
      ) : null}
      {member?.address ? (
        <ul
          className="flex list-disc flex-col gap-1.5 pl-5 text-sm"
          data-testid="offer-terms"
        >
          {(mode === "pair"
            ? pairOfferWords(member.name, member.address)
            : handOverWords(member.name, member.address)
          ).map((line) => (
            <li key={line}>{line}</li>
          ))}
          {lasts.data !== undefined ? (
            <li data-testid="offer-lasts">
              The offer lasts {spanOf(lasts.data)}. If it is not taken, nothing
              changes and you can offer again.
            </li>
          ) : null}
        </ul>
      ) : null}
      {send?.through === "pair" ? (
        <p className="text-sm text-muted">{PAIR_WORDS}</p>
      ) : null}
    </PotSheet>
  );
}
