/**
 * Hand the runner seat to a Council of five accounts (`docs/next-version/COUNCIL-PLAN.md` section 6.5): the third choice
 * beside "Hand over to one person", for the present runner only (a single founder, or a Pair signer). It takes two steps —
 * the offer of the seat, then anyone makes the Council — and the address commits to the five accounts and a salt read from
 * the Launcher, so what is offered is exactly the Council those five make.
 *
 * The sheet is loaded only when it is first opened (the seat section lazy-loads it): the accounts, the address and the two
 * presses are not in the first download. A Pair signer's offer is a proposal, as every other runner press: the other signer
 * confirms it, and only then does the Treasury hold the offer.
 *
 * The five fields take an account pasted in, or the name of someone on the project whose account is known; a paste of five
 * addresses fills all five. Each says what it understood and its short address. The presses send exactly what the sheet
 * shows: `handOver(councilAddress, false)`, then `makeCouncil(key, five, salt)`.
 */
import {
  councilAddressData,
  handOverCall,
  makeCouncilCall,
} from "@creaton/core/pot/pot-calls.ts";
import { readSeatState } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import type { ProjectNumbers } from "../money/numbers";
import { addressFromWord } from "../money/wallet";
import type { GrantMember } from "../pot/GrantSheet";
import { PotSheet } from "../pot/PotSheet";
import { RunnerAskNote } from "../pot/RunnerAskNote";
import { doneWords, runnerSend } from "../pot/runner-calls";
import type { Ready } from "../pot/use-pot";
import {
  HAND_OVER_COUNCIL,
  MAKE_COUNCIL,
  OFFER_SEAT,
  handOverIntro,
  refusalWords,
  seatFieldLabel,
} from "./council-words";

/** Five accounts, each an address; the state of one field as the person typed it. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A 32-byte salt for the address the Council is made at: nothing is guessed, and the same five may have more than one. */
function randomSalt(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The address a field means: a pasted account, or the account of someone on the project with that name; else null. */
function addressOf(
  text: string,
  members: readonly GrantMember[],
): string | null {
  const what = text.trim();
  if (what === "") return null;
  if (ADDRESS.test(what)) return what.toLowerCase();
  const named = members.find(
    (m) => m.address !== null && m.name.toLowerCase() === what.toLowerCase(),
  );
  return named?.address?.toLowerCase() ?? null;
}

/** What one field says under it: the account it understood (with its short address), or that it is not one yet. */
function fieldWords(text: string, address: string | null): string {
  if (text.trim() === "") return "";
  if (address === null) return "That is not an account yet.";
  return shortAddress(address);
}

interface Props {
  numbers: ProjectNumbers;
  ready: Ready;
  /** The team members' accounts, which the fields may take by name. */
  members: readonly GrantMember[];
  open: boolean;
  onClose: () => void;
}

export function HandOverCouncilSheet({
  numbers,
  ready,
  members,
  open,
  onClose,
}: Props) {
  const titleId = useId();
  const treasury = numbers.contracts.treasury;
  const rule = numbers.vote?.rule ?? null;
  // A salt per mounted sheet: a retry offers the same address, so nothing is offered twice under two names.
  const [salt] = useState(randomSalt);
  const [fields, setFields] = useState<string[]>(["", "", "", "", ""]);
  const [attempted, setAttempted] = useState(false);
  // The offer that just landed keeps the sheet open for its second step (making the Council); a close pressed before that
  // step lands still closes, and once the sheet is the make step Escape closes it as usual.
  const justOffered = useRef(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  // The offer that is open on the Treasury, if any.
  const seat = useQuery({
    queryKey: [
      "pot",
      "seat",
      numbers.contracts.treasury,
      ready.address.toLowerCase(),
    ],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readSeatState(ready.read, numbers.contracts.treasury),
  });
  const addresses = fields.map((text) => addressOf(text, members));
  const five =
    addresses.length === 5 && addresses.every((a): a is string => a !== null)
      ? addresses
      : null;
  const distinct = five !== null && new Set(five).size === five.length;
  // Where the five would make the Council: read from the Launcher, never worked out here.
  const council = useQuery({
    queryKey: [
      "pot",
      "council-address",
      numbers.key,
      five?.join(",") ?? "",
      salt,
    ],
    enabled: open && five !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!five) throw new Error("Five accounts are needed.");
      const answer = await ready.read(
        numbers.launcher,
        councilAddressData({ key: numbers.key, members: five, salt }),
      );
      const address = addressFromWord(answer.slice(0, 66));
      if (!address) throw new Error("The network gave no address.");
      return address;
    },
  });
  const councilAddress = council.data ?? null;
  const offeredNow =
    Boolean(councilAddress) && seat.data?.offeredTo === councilAddress;
  // The offer this sheet made is gone (it ran out): say so and offer it again, rather than leave a press that cannot run.
  const ranOut = attempted && !offeredNow && seat.data !== undefined;
  const inner =
    treasury && councilAddress
      ? handOverCall({ treasury, next: councilAddress, founderLeaves: false })
      : null;
  const send = inner ? runnerSend(numbers, ready.address, inner) : null;
  const through = send?.through ?? "alone";
  const make =
    treasury && councilAddress && five
      ? makeCouncilCall({
          launcher: numbers.launcher,
          key: numbers.key,
          members: five,
          salt,
        })
      : null;
  if (!rule || !treasury) return null;
  const intro = handOverIntro(rule.needed, rule.seats);
  const setField = (index: number, text: string) =>
    setFields((was) => was.map((old, i) => (i === index ? text : old)));
  /** A paste of five addresses fills all five; anything else pastes into the field as usual. */
  const paste = (text: string): boolean => {
    const found = text
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (found.length !== 5 || !found.every((part) => ADDRESS.test(part)))
      return false;
    setFields(found.map((part) => part.toLowerCase()));
    return true;
  };
  const focusNext = (index: number) => {
    const next = inputs.current[index + 1] ?? inputs.current[0] ?? null;
    next?.focus();
  };
  return (
    <PotSheet
      account={ready.address}
      action={
        offeredNow
          ? `council-make:${numbers.chainId}:${councilAddress}`
          : `council-offer:${numbers.chainId}:${councilAddress ?? treasury}`
      }
      blocked={
        offeredNow
          ? !make
          : !send || five === null || !distinct || councilAddress === null
      }
      calls={offeredNow ? (make ? [make] : null) : (send?.calls ?? null)}
      chainId={numbers.chainId}
      confirmLabel={offeredNow ? MAKE_COUNCIL : OFFER_SEAT}
      description={
        offeredNow
          ? "Make the Council the seat was offered to"
          : "Offer the seat that runs the project's money to a Council of five accounts"
      }
      detail={councilAddress ? `council:${councilAddress}` : undefined}
      done={
        offeredNow
          ? "The Council runs the project now."
          : doneWords(through, "Offered. Anyone can make the Council now.")
      }
      landed={
        offeredNow
          ? async (wallet) =>
              (
                await readSeatState(
                  (to, data) => wallet.readCall(to, data),
                  treasury,
                )
              ).runner === councilAddress
          : through === "alone" && councilAddress
            ? async (wallet) =>
                (
                  await readSeatState(
                    (to, data) => wallet.readCall(to, data),
                    treasury,
                  )
                ).offeredTo === councilAddress
            : undefined
      }
      lookLabel={offeredNow ? "Look for the Council" : "Look for your offer"}
      onLanded={() => {
        setAttempted(true);
        if (!offeredNow) justOffered.current = true;
      }}
      onOpenChange={(value) => {
        if (!value && justOffered.current) {
          justOffered.current = false;
          return;
        }
        if (!value) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="seat"
      recheck={
        offeredNow
          ? async () => {
              const now = await readSeatState(ready.read, treasury);
              return now.offeredTo === councilAddress
                ? null
                : refusalWords("offer-ran-out");
            }
          : undefined
      }
      testId="council-offer-sheet"
      title={HAND_OVER_COUNCIL}
    >
      <p className="text-sm" data-testid="council-offer-intro" id={titleId}>
        {intro}
      </p>
      <div className="flex flex-col gap-3">
        {fields.map((text, index) => {
          const address = addresses[index] ?? null;
          const said = fieldWords(text, address);
          const fieldId = `${titleId}-seat-${index + 1}`;
          return (
            <div className="flex flex-col gap-1" key={fieldId}>
              <label className="text-sm font-semibold" htmlFor={fieldId}>
                {seatFieldLabel(index)}
              </label>
              <input
                aria-describedby={said ? `${fieldId}-said` : undefined}
                autoComplete="off"
                className="field"
                data-testid={`council-offer-field-${index + 1}`}
                id={fieldId}
                onChange={(e) => setField(index, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    focusNext(index);
                  }
                }}
                onPaste={(e) => {
                  if (paste(e.clipboardData.getData("text")))
                    e.preventDefault();
                }}
                ref={(el) => {
                  inputs.current[index] = el;
                }}
                spellCheck={false}
                value={text}
              />
              {said ? (
                <p className="text-xs text-muted" id={`${fieldId}-said`}>
                  {said}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {five !== null && !distinct ? (
        <p className="text-sm text-danger" role="alert">
          A list needs five different accounts.
        </p>
      ) : null}
      {council.isError ? (
        <p
          className="text-sm"
          data-testid="council-address-failed"
          role="alert"
        >
          The network could not say which Council these five make, so nothing
          can be offered now. Nothing changed. Press again in a moment.
        </p>
      ) : null}
      {ranOut ? (
        <p
          className="text-sm text-danger"
          data-testid="council-ran-out"
          role="alert"
        >
          {refusalWords("offer-ran-out")}
        </p>
      ) : null}
      {offeredNow && councilAddress ? (
        <p className="text-sm" data-testid="council-offered">
          The seat is offered to the Council of these five at{" "}
          {shortAddress(councilAddress)}. Until it is made you still run the
          project.
        </p>
      ) : null}
      {!offeredNow ? (
        <RunnerAskNote numbers={numbers} through={through} />
      ) : null}
      {councilAddress && five ? (
        <p className="text-xs text-muted" data-testid="council-offer-address">
          These five make a Council at {shortAddress(councilAddress)}.
        </p>
      ) : null}
    </PotSheet>
  );
}
