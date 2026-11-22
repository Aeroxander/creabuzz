/**
 * A seat holder's waiting list (`docs/next-version/COUNCIL-PLAN.md` section 6.4): one row per call the other seats have
 * put forward and not yet run, what it does in plain words (the Council's own `Proposed` logs, read through
 * `council/proposals.ts` — the same decoder the Pair uses), how many seats have agreed, and the one press the seat has:
 * **Agree**, or, once it has agreed, **Take back my agreement**.
 *
 * The events carry no clock, so the list cannot know by itself when a call ran out: the record's own count of live waits
 * is what says which rows still wait, and the ones beyond it say "This ran out; propose it again if it is still needed."
 * rather than offer a press that cannot run. `PUBLIC_LINE` is under the list, word for word, once.
 */
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import type { MoneyCall } from "../money/calls";
import type { ProjectNumbers } from "../money/numbers";
import type { CouncilNumbers } from "../money/numbers-types";
import { potProblem } from "../money/pot-copy";
import { useMoneySend } from "../money/use-money";
import { type ChainLog, type MoneyWallet, readLogsBack } from "../money/wallet";
import { recordFitsBuild, usePotWallet } from "../pot/use-pot";
import {
  AGREE,
  agreedLine,
  PUBLIC_LINE,
  RAN_OUT,
  TAKE_BACK_AGREEMENT,
  WAITING_HEADING,
} from "./council-words";
import {
  PROPOSED_TOPIC,
  type WaitingAction,
  waitingActions,
} from "./proposals";
import {
  councilAgreeCall,
  councilWithdrawCall,
} from "@creaton/core/pot/pot-calls.ts";

/** The Council's agreement event, whose `by` topic is the seat that agreed. */
const AGREED_TOPIC = topicOf("Agreed(bytes32,address,uint8)");

/** How far back a Council's waiting calls are looked for: about a week of blocks, in pieces a wallet's node accepts. */
const WAITING_WINDOW = 50_000;

/** The most ran-out rows shown under the live ones: old proposals must not bury what waits now. */
const MOST_RAN_OUT = 3;

const addressWord = (address: string) =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** What the list found: the calls still waiting, and which of them this seat has agreed to. */
interface Found {
  actions: WaitingAction[];
  agreedByMe: ReadonlySet<string>;
  complete: boolean;
}

/** The proposals this seat has agreed to: `Agreed` logs name the seat in their second topic. */
function agreedBySeat(
  logs: readonly ChainLog[],
  council: string,
  me: string,
): Set<string> {
  const mine = addressWord(me);
  const found = new Set<string>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== council.toLowerCase()) continue;
    const [topic, id, by] = log.topics.map((t) => t.toLowerCase());
    if (topic === AGREED_TOPIC && id !== undefined && by === mine)
      found.add(id);
  }
  return found;
}

/** One press of a row: one send, the network's own refusal in plain words, and a fresh read on what landed. */
function Press({
  label,
  accessibleName,
  action,
  chainId,
  build,
  done,
  onDone,
  testId,
  variant = "primary",
}: {
  label: string;
  /** The row's own name for a screen reader: "Agree: {what}", so no two presses share a name. */
  accessibleName: string;
  action: string;
  chainId: number;
  build: (wallet: MoneyWallet) => MoneyCall[];
  done: string;
  onDone: () => void;
  testId: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const send = useMoneySend(action);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        aria-label={accessibleName}
        data-testid={testId}
        disabled={send.isPending}
        onClick={() => {
          setProblem(null);
          send.send(
            { chainId, build },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: ["pot"] });
                toast(done, "done");
                onDone();
              },
              onError: (error) => setProblem(potProblem(error, "seat")),
            },
          );
        }}
        size="sm"
        variant={variant}
      >
        {send.isPending
          ? send.words.waiting
          : send.waiting
            ? send.words.lookFor
            : label}
      </Button>
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid={`${testId}-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export function WaitingActions({
  numbers,
  council,
  address,
  nameOf,
}: {
  numbers: ProjectNumbers;
  council: CouncilNumbers;
  /** The seat holder whose list it is: their seat is what agrees and takes its agreement back. */
  address: string;
  nameOf: (address: string) => string;
}) {
  const pot = usePotWallet(numbers.chainId);
  const usable =
    Boolean(address) && pot.onChain === true && recordFitsBuild(numbers);
  const query = useQuery({
    queryKey: [
      "pot",
      "council-waiting",
      numbers.chainId,
      council.contract,
      address.toLowerCase(),
      council.generation,
    ],
    enabled: usable,
    staleTime: 15_000,
    retry: false,
    queryFn: async (): Promise<Found> => {
      const to = await pot.wallet.blockNumber();
      const read = await readLogsBack(
        pot.wallet,
        { address: council.contract, topics: [PROPOSED_TOPIC] },
        { from: Math.max(0, to - WAITING_WINDOW), to },
      );
      return {
        actions: waitingActions({
          logs: read.logs,
          council: council.contract,
          nameOf,
        }),
        agreedByMe: agreedBySeat(read.logs, council.contract, address),
        complete: read.complete,
      };
    },
  });
  const asked = query.data?.actions ?? [];
  // The record counts the calls that still wait; anything older than its count has run out (the events carry no clock).
  const liveCount =
    council.waiting && !council.waiting.truncated
      ? council.waiting.count
      : null;
  const live = liveCount === null ? asked : asked.slice(0, liveCount);
  const ranOut =
    liveCount === null ? [] : asked.slice(liveCount, liveCount + MOST_RAN_OUT);
  const mine = query.data?.agreedByMe ?? new Set<string>();
  return (
    <div className="flex flex-col gap-2" data-testid="council-waiting">
      <h3 className="font-semibold">{WAITING_HEADING}</h3>
      {query.isPending ? (
        <p className="text-sm text-muted">Looking on the network…</p>
      ) : query.isError ? (
        <div
          className="flex flex-col items-start gap-2"
          data-testid="council-waiting-failed"
        >
          <p className="text-sm">
            The waiting calls could not be read from your wallet's network, so
            nothing is shown about them now.
          </p>
          <Button onClick={() => void query.refetch()} variant="secondary">
            Try again
          </Button>
        </div>
      ) : live.length === 0 && ranOut.length === 0 ? (
        <p className="text-sm text-muted" data-testid="council-waiting-none">
          {query.data?.complete === false
            ? "Nothing waiting in the last week of blocks."
            : "Nothing is waiting for your agreement."}
        </p>
      ) : (
        <>
          <ul
            className="flex flex-col gap-2"
            data-testid="council-waiting-list"
          >
            {live.map((action) => {
              const agreed = mine.has(action.id);
              return (
                <li
                  className="flex flex-col gap-1.5 rounded-xl bg-white/6 px-3 py-2"
                  data-testid="council-waiting-row"
                  key={action.id}
                >
                  <p className="text-sm font-semibold">{action.words}</p>
                  <p className="text-xs text-muted">
                    {agreedLine(action.agreed, council.needed)}
                  </p>
                  {action.kind === "other" ? null : agreed ? (
                    <Press
                      accessibleName={`${TAKE_BACK_AGREEMENT}: ${action.words}`}
                      action={`council-withdraw:${numbers.chainId}:${council.contract}:${action.id}`}
                      build={() => [
                        councilWithdrawCall(council.contract, action.id),
                      ]}
                      chainId={numbers.chainId}
                      done="Your agreement is taken back."
                      label={TAKE_BACK_AGREEMENT}
                      onDone={() => void query.refetch()}
                      testId="council-withdraw"
                      variant="ghost"
                    />
                  ) : (
                    <Press
                      accessibleName={`${AGREE}: ${action.words}`}
                      action={`council-agree:${numbers.chainId}:${council.contract}:${action.id}`}
                      build={() => [
                        councilAgreeCall(
                          council.contract,
                          action.target,
                          action.data,
                          action.nonce,
                        ),
                      ]}
                      chainId={numbers.chainId}
                      done="Agreed."
                      label={AGREE}
                      onDone={() => void query.refetch()}
                      testId="council-agree"
                    />
                  )}
                </li>
              );
            })}
            {ranOut.map((action) => (
              <li
                className="flex flex-col gap-1 rounded-xl bg-white/6 px-3 py-2"
                data-testid="council-waiting-ran-out"
                key={action.id}
              >
                <p className="text-sm font-semibold">{action.words}</p>
                <p className="text-sm text-muted">{RAN_OUT}</p>
              </li>
            ))}
          </ul>
          {live.length > 0 ? (
            <p
              className="text-sm text-muted"
              data-testid="council-waiting-public"
            >
              {PUBLIC_LINE}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
