import { useId, useState } from "react";
import {
  nameOf as profileName,
  type ProfileMetadata,
} from "../../lib/profiles";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import { useWalletAddress } from "../money/use-money";
import { PairCard } from "./PairCard";
import { SendSheet } from "./SendSheet";
import {
  directCall,
  handOverData,
  LAUNCHER_READS,
  makePairCall,
  takeSeatCall,
} from "./team-calls";
import { readAddress, usePair, useSeatOffer } from "./use-team";
import { useTeamWallets } from "./use-wallets";

/**
 * Team's next step, above the project's tabs (loaded only where the server turns investing on and the project has
 * numbers): the seat offered to this wallet, the founder's "Add a second person", or the Pair's card for its signers.
 */
export function TeamTop({
  numbers,
  founder,
  team,
  profiles,
}: {
  numbers: ProjectNumbers;
  /** The founder's account key. */
  founder: string;
  /** Every teammate's account key (the founder first). */
  team: readonly string[];
  profiles: Record<string, ProfileMetadata> | undefined;
}) {
  const me = useWalletAddress().data ?? null;
  const pair = usePair(numbers).data ?? null;
  const offer = useSeatOffer(numbers, me).data ?? null;
  const wallets = useTeamWallets(team).data;
  const byAddress = new Map<string, string>();
  for (const [pubkey, w] of Object.entries(wallets ?? {}))
    if (w.state === "linked") byAddress.set(w.address, pubkey);
  const nameOf = (address: string) => {
    const pubkey =
      byAddress.get(address) ?? (address === numbers.founder ? founder : null);
    return pubkey
      ? profileName(profiles, pubkey)
      : `the wallet ending ${address.slice(-4)}`;
  };
  const runsAlone = Boolean(me && numbers.runner === me);
  const canAddSecond =
    runsAlone &&
    !numbers.clock.woundDown &&
    (numbers.stage.name === "solo" || numbers.stage.name === "backed");
  const mates = team
    .filter((pubkey) => pubkey !== founder)
    .map((pubkey) => ({ pubkey, wallet: wallets?.[pubkey] }));
  return (
    <>
      {offer && me ? (
        <SeatOfferCard
          first={offer.kind === "second" ? offer.first : null}
          kind={offer.kind}
          nameOf={nameOf}
          numbers={numbers}
        />
      ) : null}
      {canAddSecond && me && mates.length > 0 ? (
        <SecondSeatCard
          mates={mates.map((m) => ({
            pubkey: m.pubkey,
            name: profileName(profiles, m.pubkey),
            address: m.wallet?.state === "linked" ? m.wallet.address : null,
          }))}
          me={me}
          numbers={numbers}
        />
      ) : null}
      {pair && me ? (
        <PairCard me={me} nameOf={nameOf} numbers={numbers} pair={pair} />
      ) : null}
    </>
  );
}

/**
 * The founder who runs the project alone asks a teammate to be the second signer: the runner seat is offered to the
 * Pair of the two of them (its address is known before it exists), and the Pair takes it when the teammate accepts.
 */
function SecondSeatCard({
  numbers,
  me,
  mates,
}: {
  numbers: ProjectNumbers;
  me: string;
  mates: { pubkey: string; name: string; address: string | null }[];
}) {
  const titleId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const treasury = numbers.contracts.treasury;
  if (!treasury) return null;
  const mate = mates.find((m) => m.pubkey === chosen) ?? null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="second-seat"
      role="region"
    >
      <div>
        <h2 className="headline text-xl" id={titleId}>
          Add a second person
        </h2>
        <p className="mt-1 text-sm text-muted">
          Run the project with a teammate: the limit on backing rises from
          10,000 to 50,000 dollars, and either of you can check in.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {mates.map((m) => (
          <li
            className="flex items-center justify-between gap-3"
            key={m.pubkey}
          >
            <span className="min-w-0 truncate font-semibold">{m.name}</span>
            {m.address ? (
              <Button
                data-testid="offer-seat"
                onClick={() => setChosen(m.pubkey)}
                size="sm"
                variant="secondary"
              >
                Make second signer
              </Button>
            ) : (
              <span
                className="text-right text-xs text-muted"
                data-testid="no-wallet"
              >
                Has not linked a wallet yet
              </span>
            )}
          </li>
        ))}
      </ul>
      {mate?.address ? (
        <OfferSeatSheet
          me={me}
          name={mate.name}
          numbers={numbers}
          onOpenChange={(open) => {
            if (!open) setChosen(null);
          }}
          teammate={mate.address}
          treasury={treasury}
        />
      ) : null}
    </Card>
  );
}

function OfferSeatSheet({
  numbers,
  me,
  name,
  teammate,
  treasury,
  onOpenChange,
}: {
  numbers: ProjectNumbers;
  me: string;
  name: string;
  teammate: string;
  treasury: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <SendSheet
      action={`offer-seat:${numbers.chainId}:${treasury}`}
      build={async (w) => {
        const next = await readAddress(
          w,
          numbers.launcher,
          LAUNCHER_READS.pairAddress(numbers.key, me, teammate),
        );
        return [directCall(treasury, handOverData(next, false))];
      }}
      chainId={numbers.chainId}
      confirmLabel="Offer the second seat"
      copy="offer-seat"
      done={`Offered. ${name} becomes the second signer when they accept.`}
      onOpenChange={onOpenChange}
      open
      testId="offer-seat-sheet"
      title={`Make ${name} the second signer?`}
    >
      <p>
        {name} accepts on the project's Money tab. From then on the project is
        run by the two of you:
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-5">
        <li>
          Either of you can check in, and spend up to 500 dollars in any 7 days
          alone.
        </li>
        <li>
          Everything else needs both of you: one asks, the other confirms.
        </li>
        <li>The limit on backing rises from 10,000 to 50,000 dollars.</li>
        <li>
          You stay the founder and keep your Shares. A second signer can be one
          person with two accounts; the page says so.
        </li>
      </ul>
    </SendSheet>
  );
}

function SeatOfferCard({
  numbers,
  kind,
  first,
  nameOf,
}: {
  numbers: ProjectNumbers;
  kind: "seat" | "second";
  first: string | null;
  nameOf: (address: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const treasury = numbers.contracts.treasury;
  if (!treasury) return null;
  const second = kind === "second" && first;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="seat-offer"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        {second
          ? "You are asked to be the second signer"
          : "You are offered the runner seat"}
      </h2>
      <p className="text-sm text-muted">
        {second
          ? `${nameOf(first)} asked you to run this project with them.`
          : "The person who runs this project offered you their seat."}
      </p>
      <Button block data-testid="seat-accept" onClick={() => setOpen(true)}>
        {second ? "Accept second seat" : "Take the seat"}
      </Button>
      <SendSheet
        action={`${second ? "accept-seat" : "take-seat"}:${numbers.chainId}:${treasury}`}
        build={() => [
          second
            ? makePairCall(numbers.launcher, numbers.key, first)
            : takeSeatCall(treasury),
        ]}
        chainId={numbers.chainId}
        confirmLabel={second ? "Accept" : "Take the seat"}
        copy={second ? "accept-seat" : "take-seat"}
        done={
          second ? "You are the second signer." : "You run the project now."
        }
        onOpenChange={setOpen}
        open={open}
        testId="seat-sheet"
        title={second ? "Become the second signer?" : "Take the runner seat?"}
      >
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          {second ? (
            <>
              <li>
                You and {nameOf(first)} run the project together. Either of you
                can check in and spend up to 500 dollars in any 7 days alone.
              </li>
              <li>
                Raises, Shares given, larger payments, handing the seat on and
                winding down need both of you: one asks, the other confirms.
              </li>
              <li>
                You check in every 14 days between you; payments pause if nobody
                does.
              </li>
            </>
          ) : (
            <>
              <li>
                You check in every 14 days, spend the project's money and decide
                its raises.
              </li>
              <li>Agents set by the last runner stop working.</li>
            </>
          )}
        </ul>
      </SendSheet>
    </Card>
  );
}
