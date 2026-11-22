/**
 * The vote card on a project's Money tab (`docs/next-version/COUNCIL-PLAN.md` section 6.2), shown only when the record
 * carries an open ballot: title by kind, the state line, one row per choice with its plain percent and the candidate's own
 * signed text (when the signed record is the one the chain stored), the count line, the presses an eligible holder may use,
 * the planned change from the moment the vote ends, and the last line of a replace card. A visitor, or a holder whose Shares
 * were not parked before the ballot opened, reads the same card with the plan's own sentence and no press.
 *
 * Every sentence is a function of the parsed record (`vote-words.ts`, `use-vote.ts`): no percent, count, date or name is
 * typed here. The candidate texts are joined from the signed records the project carries (`KIND_LAUNCH_UPDATE` with a
 * `candidacy` mark): a text is shown only when its record's id is the hash the chain stored and its tags name the same
 * proposer and accounts, so a text can never be swapped after people voted. The chain is read for the person's parked
 * Shares (the eligibility hint) and, while a ballot is live, for their own choice; a read that fails shows no press, never a
 * guess.
 */
import { KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";
import { castVoteCall } from "@creaton/core/pot/pot-calls.ts";
import { ballotOf } from "@creaton/core/pot/pot-reads.ts";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { read } from "../../lib/relay";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useMoneySend } from "../money/use-money";
import type { ProjectNumbers } from "../money/numbers";
import type { VoteNumbers, VoteOptionNumbers } from "../money/numbers-types";
import { parkedHeld } from "../pause/parked-read";
import { usePotWallet } from "../pot/use-pot";
import { refusalOf, refusalWords, REFUSAL_FALLBACK } from "./council-words";
import { useVote } from "./use-vote";
import {
  CANNOT_VOTE,
  candidacyText,
  countLine,
  endedLine,
  lastLine,
  NO_TEXT,
  onlyBackersLine,
  optionPercent,
  optionWords,
  plannedChangeLine,
  proposerLine,
  PUBLIC_LINE,
  replaceIntro,
  seatsResultLine,
  seatsStayLine,
  standPressWords,
  standingLine,
  staleLine,
  votePressName,
  voteTitle,
  votingLine,
  YOUR_VOTE,
} from "./vote-words";

const StandSheet = lazy(() =>
  import("./StandSheet").then((m) => ({ default: m.StandSheet })),
);

/** How long a result that changes nothing keeps its card (section 6.2), in seconds. */
const ENDED_SHOWN_SECS = 3 * 86_400;

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

/** A candidate's signed text, as its own record carries it. */
export interface Candidacy {
  id: string;
  text: string;
  proposer: string | null;
  candidates: string[];
}

/** The text in a `candidacy` record's content, or null when it is not one this app may show. */
function candidacyOf(event: {
  id: string;
  tags: string[][];
  content: string;
}): Candidacy | null {
  const mark = event.tags.find((t) => t[0] === "candidacy");
  if (!mark) return null;
  const proposer = event.tags.find((t) => t[0] === "proposer")?.[1] ?? null;
  const candidates = event.tags
    .filter((t) => t[0] === "candidate")
    .map((t) => (t[1] ?? "").toLowerCase());
  let text: unknown;
  try {
    text = (JSON.parse(event.content) as { v?: unknown; text?: unknown }).text;
  } catch {
    return null;
  }
  if (typeof text !== "string" || text.length === 0) return null;
  // A text longer than the plan's 280 characters is not one the sheet could have signed: never shown.
  if (text.length > 280) return null;
  return {
    id: event.id.toLowerCase(),
    text,
    proposer: proposer === null ? null : proposer.toLowerCase(),
    candidates,
  };
}

/** Every candidacy a project carries, by the id the chain stored for it. */
export function candidaciesOf(
  events: readonly { id: string; tags: string[][]; content: string }[],
): Map<string, Candidacy> {
  const out = new Map<string, Candidacy>();
  for (const event of events) {
    const candidacy = candidacyOf(event);
    if (candidacy) out.set(candidacy.id, candidacy);
  }
  return out;
}

/**
 * Whether a signed text is the one the chain stored for this option: its id is the record hash, and its tags name the same
 * proposer and the same accounts in the same seat order (section 5.4). Anything else reads "No text".
 */
function textFor(
  option: VoteOptionNumbers,
  texts: Map<string, Candidacy> | undefined,
): string {
  if (!option.recordHash) return "";
  const signed = texts?.get(option.recordHash.toLowerCase()) ?? null;
  const matches =
    signed !== null &&
    (signed.proposer ?? null) === (option.proposer ?? null) &&
    signed.candidates.length === option.members.length &&
    signed.candidates.every(
      (account, i) => account === (option.members[i] ?? "").toLowerCase(),
    );
  return candidacyText(option.recordHash, matches ? signed : null);
}

/** The card's answer for a refusal, in the copy module's plain words: never a contract's name. */
function refusalFor(
  error: unknown,
  press: "vote" | "stand" | "stand-list" | "open-replace",
  vote: VoteNumbers,
  nameOf: (address: string) => string,
): string {
  const open = vote.open;
  const refusal = refusalOf(error, press, open?.phase ?? null);
  if (!refusal) return REFUSAL_FALLBACK;
  return refusalWords(
    refusal,
    { rule: vote.rule, nameOf, phase: open?.phase ?? null },
    open?.standEnd ?? null,
  );
}

function invalidate(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["money"] });
  void queryClient.invalidateQueries({ queryKey: ["pot"] });
}

export function VoteCard({
  numbers,
  now,
  address,
  projectCoordinate,
  holds,
  nameOf,
  parked,
}: {
  /** The record with its milestone 9 keys read (`withStepKeys`), as the Money tab holds it. */
  numbers: ProjectNumbers;
  now: number;
  /** The signed-in account's chain address, or null (a visitor). */
  address: string | null;
  /** The project's coordinate, for the records a candidate signed (`null` hides every press). */
  projectCoordinate: string | null;
  /** Whether the record lists this account among the holders (a visitor holds nothing). */
  holds: boolean;
  /** A name for an account, as the project page shows accounts (a linked name, else a short address). */
  nameOf: (address: string) => string;
  /** The person's parked Shares, when the screen already read them; otherwise the card reads the chain. */
  parked?: bigint | null;
}) {
  const pot = usePotWallet(numbers.chainId);
  const queryClient = useQueryClient();
  const vote = numbers.vote ?? null;
  const open = vote?.open ?? null;
  const parkedRead = useQuery({
    queryKey: ["pot", "vote-parked", numbers.contracts.treasury, pot.address],
    enabled: parked === undefined && pot.address !== null && open !== null,
    staleTime: 15_000,
    retry: false,
    queryFn: () => parkedHeld(pot.read, numbers, pot.address as string),
  });
  const mine = parked !== undefined ? parked : (parkedRead.data ?? null);
  const view = useVote({ numbers, now, parked: mine });
  const live = useQuery({
    queryKey: ["pot", "vote-mine", vote?.contract, address, open?.id],
    enabled:
      address !== null &&
      open !== null &&
      (open.phase === "standing" || open.phase === "voting"),
    staleTime: 10_000,
    retry: false,
    queryFn: () =>
      ballotOf(pot.read, vote?.contract as string, address as string),
  });
  const texts = useQuery({
    queryKey: ["vote", "texts", projectCoordinate, open?.id],
    enabled:
      projectCoordinate !== null &&
      (open?.options.some((option) => option.recordHash !== null) ?? false),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const events = await read({
        kinds: [KIND_LAUNCH_UPDATE],
        "#a": [projectCoordinate as string],
        limit: 500,
      });
      return candidaciesOf(events);
    },
  });
  const send = useMoneySend(`vote:${numbers.chainId}:${vote?.contract ?? ""}`);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [standMode, setStandMode] = useState<"person" | "list" | null>(null);

  if (!vote || !open || !view) return null;
  const phase = view.phase ?? open.phase;
  // A card that belongs to no one any more: put in, or let go. Anything but the plan's own states shows nothing.
  if (phase === "carried-out" || phase === "lapsed") return null;
  // A result that changed nothing shows for three days and then is gone.
  if (phase === "ended" && now > open.voteEnd + ENDED_SHOWN_SECS) return null;
  const old = view.old;
  const council = numbers.council ?? null;
  const rule = vote.rule;
  const kind = open.kind;
  const livePhase = phase === "standing" || phase === "voting";
  // Only a signed-in account the record lists among the holders may press: a visitor reads the card.
  const signedIn = address !== null && holds;
  const canVoteNow =
    signedIn && !old && phase === "voting" && view.canVote === true;
  const mayStand =
    signedIn &&
    !old &&
    phase === "standing" &&
    projectCoordinate !== null &&
    (view.canStand ?? (mine ?? 0n) > 0n);
  const notBacker = address === null || !holds;
  const explain =
    !old && livePhase
      ? notBacker
        ? onlyBackersLine()
        : view.canVote === false
          ? CANNOT_VOTE
          : null
      : null;
  const shownTexts = texts.data;
  const myOption =
    live.data && live.data.id === open.id ? live.data.option : null;
  const runnerKind =
    numbers.runner.kind ?? (numbers.runner.isPair ? "pair" : "single");
  const nameOfAccount = (account: string) => {
    const shown = nameOf(account);
    const short = shortAddress(account);
    return shown === short || shown === account ? short : `${shown} (${short})`;
  };

  const cast = (option: VoteOptionNumbers) => {
    setProblem(null);
    setNote(null);
    send.send(
      {
        chainId: numbers.chainId,
        build: () => [castVoteCall(vote.contract, option.index)],
      },
      {
        onSuccess: () => {
          setNote("Your vote is in.");
          invalidate(queryClient);
        },
        onError: (error) =>
          setProblem(refusalFor(error, "vote", vote, nameOfAccount)),
      },
    );
  };

  const titleId = `vote-title-${open.id}`;
  const rows = open.options.map((option) => {
    const signed = textFor(option, shownTexts);
    const words = optionWords({ option, kind, council, nameOf: nameOfAccount });
    const prop = proposerLine(option, nameOfAccount);
    const me = address?.toLowerCase() ?? null;
    const mineRow =
      option.kind !== "keep" &&
      (option.proposer === me || option.members.includes(me ?? ""));
    const yourVote = myOption !== null && myOption === option.index;
    return (
      <li
        className="flex flex-col gap-1.5 border-t border-white/10 pt-3 first:border-t-0 first:pt-0"
        data-testid={`vote-row-${option.index}`}
        key={option.index}
      >
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-sm font-semibold text-ink">{words}</p>
          {old ? null : (
            <span className="num shrink-0 text-sm">
              {optionPercent(open, option)}
            </span>
          )}
        </div>
        {signed ? (
          <p className="text-sm text-muted" data-testid="vote-text">
            {signed}
          </p>
        ) : option.kind === "keep" ? null : (
          <p className="text-sm text-muted" data-testid="vote-text">
            {NO_TEXT}
          </p>
        )}
        {prop ? (
          <p className="text-sm text-muted" data-testid="vote-proposer">
            {prop}
          </p>
        ) : null}
        {yourVote ? (
          <p className="text-sm font-semibold" data-testid="vote-yours">
            {YOUR_VOTE}
          </p>
        ) : null}
        {!old && me !== null && mineRow ? (
          <p className="text-sm" data-testid="vote-standing">
            You are standing.
          </p>
        ) : null}
        {canVoteNow ? (
          <Button
            aria-label={votePressName({
              option,
              kind,
              council,
              nameOf: nameOfAccount,
            })}
            data-testid={`vote-press-${option.index}`}
            disabled={send.isPending}
            onClick={() => cast(option)}
            variant="secondary"
          >
            {send.isPending ? send.words.waiting : "Vote for this"}
          </Button>
        ) : null}
      </li>
    );
  });

  let stateLine: string | null;
  let afterLine: string | null = null;
  if (old) stateLine = null;
  else if (phase === "standing")
    stateLine = standingLine({ vote: open, rule, council });
  else if (phase === "voting") stateLine = votingLine(open);
  else if (phase === "ended")
    stateLine =
      kind === "seats"
        ? seatsResultLine({ vote: open, nameOf: nameOfAccount })
        : endedLine();
  else
    stateLine =
      kind === "seats"
        ? seatsResultLine({ vote: open, nameOf: nameOfAccount })
        : plannedChangeLine({ vote: open, nameOf: nameOfAccount, runnerKind });
  if (kind === "replace") afterLine = lastLine();

  return (
    <>
      <Card
        aria-labelledby={titleId}
        className="flex flex-col gap-3"
        data-testid="vote-card"
        role="region"
      >
        <h2 className="headline text-xl" id={titleId}>
          {voteTitle({ vote: open, council })}
        </h2>
        {kind === "replace" ? (
          <p className="text-sm text-muted" data-testid="vote-intro">
            {replaceIntro(rule)}
          </p>
        ) : null}
        {old ? (
          <p className="text-sm" data-testid="vote-stale">
            {staleLine()}
          </p>
        ) : stateLine ? (
          <p className="text-sm" data-testid={`vote-state-${phase}`}>
            {stateLine}
          </p>
        ) : null}
        {mayStand ? (
          <Button
            data-testid="vote-stand"
            onClick={() => setStandMode(kind === "replace" ? "list" : "person")}
            variant="secondary"
          >
            {standPressWords(kind)}
          </Button>
        ) : null}
        {(old ? false : phase !== "standing") && open.options.length > 0 ? (
          <ul
            className="m-0 flex list-none flex-col gap-3 p-0"
            data-testid="vote-rows"
          >
            {rows}
          </ul>
        ) : null}
        {!old && phase !== "standing" ? (
          <p className="text-sm text-muted" data-testid="vote-count">
            {countLine(open, rule)}
          </p>
        ) : null}
        {!old && kind === "seats" && phase === "voting" ? (
          <p className="text-sm text-muted" data-testid="vote-stay">
            {seatsStayLine()}
          </p>
        ) : null}
        {afterLine ? (
          <p className="text-sm text-muted" data-testid="vote-last">
            {afterLine}
          </p>
        ) : null}
        {note ? (
          <p className="text-sm" data-testid="vote-note">
            {note}
          </p>
        ) : null}
        {problem ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
            data-testid="vote-problem"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        {explain ? (
          <p className="text-sm text-muted" data-testid="vote-explain">
            {explain}
          </p>
        ) : null}
      </Card>
      {canVoteNow || mayStand ? (
        <p className="text-sm text-muted" data-testid="vote-public">
          {PUBLIC_LINE}
        </p>
      ) : null}
      {standMode ? (
        <Suspense fallback={null}>
          <StandSheet
            mode={standMode}
            now={now}
            nameOf={nameOf}
            numbers={numbers}
            onClose={() => setStandMode(null)}
            open
            projectCoordinate={projectCoordinate}
          />
        </Suspense>
      ) : null}
    </>
  );
}
