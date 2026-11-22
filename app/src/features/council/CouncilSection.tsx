/**
 * The Council section of a project's Team part (`docs/next-version/COUNCIL-PLAN.md` section 6.4), drawn only when the
 * record says the runner is a Council: what the Council is, its five seats with their short addresses and the dates they
 * were taken, when two seats next come up, and, for a seat holder, what waits for their agreement. A person who holds no
 * seat reads the seats and finds nothing to press.
 *
 * Nothing new shows on a project with no Council. A record that says it runs on a Council but whose Council cannot be
 * read says so and offers no press (6.6). The words are `council-words.ts`, so no sentence and no number is typed here.
 */
import { useId } from "react";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import type { CouncilNumbers } from "../money/numbers-types";
import {
  COUNCIL_HEADING,
  COUNCIL_UNREADABLE,
  councilLastLine,
  councilSummary,
  nextElectionLine,
  proposeAskLine,
  seatLine,
} from "./council-words";
import { useCouncil } from "./use-council";
import { WaitingActions } from "./WaitingActions";

/** The five seats, by number: a seat's number is its identity, so it is the key of its row. */
const SEAT_NUMBERS = [1, 2, 3, 4, 5] as const;

/** The short form of an account, as the app shows any account it has no name for. */
const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

interface Props {
  /** The record with its milestone 9 keys read (the Money tab passes what `withStepKeys` gave it). */
  numbers: ProjectNumbers;
  /** The signed-in account, or null: only a seat holder sees the waiting list and the presses. */
  address: string | null;
  /** A name for an account, as the project shows it (a linked name, else its short address). */
  nameOf: (address: string) => string;
  now: number;
}

export function CouncilSection({ numbers, address, nameOf, now }: Props) {
  const titleId = useId();
  const view = useCouncil({ numbers, address, now });
  if (!view || view.state.kind === "none") return null;
  const me = address ? address.toLowerCase() : null;
  /** A seat's name; the short address is drawn beside it, once, for every held seat. */
  const labelOf = (account: string) => {
    const said = nameOf(account).trim();
    return said === "" || /^0x[0-9a-fA-F]{4}/.test(said)
      ? shortAddress(account)
      : said;
  };
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="council-section"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        {COUNCIL_HEADING}
      </h2>
      {view.state.kind === "unreadable" || !view.council ? (
        <p className="text-sm" data-testid="council-unreadable">
          {COUNCIL_UNREADABLE}
        </p>
      ) : (
        <CouncilBody
          address={address}
          council={view.council}
          labelOf={labelOf}
          me={me}
          nameOf={nameOf}
          needed={view.needed ?? view.council.needed}
          now={now}
          numbers={view.numbers}
          voteOpen={Boolean(
            view.numbers.vote?.open &&
              view.numbers.vote.open.kind === "seats" &&
              now < view.numbers.vote.open.voteEnd,
          )}
        />
      )}
    </Card>
  );
}

function CouncilBody({
  address,
  council,
  labelOf,
  me,
  nameOf,
  needed,
  now,
  numbers,
  voteOpen,
}: {
  address: string | null;
  council: CouncilNumbers;
  labelOf: (account: string) => string;
  me: string | null;
  nameOf: (address: string) => string;
  needed: number;
  now: number;
  numbers: ProjectNumbers;
  voteOpen: boolean;
}) {
  const isSeat = Boolean(
    me && council.seats.some((seat) => seat.account === me),
  );
  return (
    <>
      <p className="text-sm" data-testid="council-summary">
        {councilSummary(council)}
      </p>
      <ul className="flex flex-col gap-1.5" data-testid="council-seats">
        {SEAT_NUMBERS.map((number) => {
          const index = number - 1;
          const seat = council.seats[index];
          if (!seat) return null;
          return (
            <li
              className="flex items-baseline justify-between gap-3 text-sm"
              data-testid="council-seat"
              key={number}
            >
              <span className="min-w-0">
                {seatLine({
                  index,
                  isMe: seat.account !== null && seat.account === me,
                  nameOf: labelOf,
                  seat,
                })}
              </span>
              {seat.account === null ? null : (
                <span className="shrink-0 font-mono text-xs text-muted">
                  {shortAddress(seat.account)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm" data-testid="council-next-election">
        {nextElectionLine({ council, now, voteOpen })}
      </p>
      {isSeat && address ? (
        <>
          {council.waiting === null ? null : (
            <WaitingActions
              address={address}
              council={council}
              nameOf={nameOf}
              numbers={numbers}
            />
          )}
          <p className="text-sm text-muted" data-testid="council-propose-line">
            {proposeAskLine(needed, council.seats.length)}
          </p>
        </>
      ) : null}
      <p className="text-sm text-muted" data-testid="council-last-line">
        {councilLastLine(council.seats.length)}
      </p>
    </>
  );
}
