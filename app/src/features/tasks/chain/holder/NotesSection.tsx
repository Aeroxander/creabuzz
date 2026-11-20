/**
 * "Money you can claim" (plan section 5.9): the tasks a person took out of while money was set aside for them, newest first,
 * each with what a claim pays now and a press to claim it. The list is made from the signed record's rows (a hint), what this
 * browser remembers of the person's own Take outs, and a look back through the network's own logs that the person asks for;
 * every figure and every press is read from the network for the connected account, because a person who took out holds no
 * Shares and is not in the record's list of holders. A look that did not reach the start of the project's tasks never says
 * "none". Nothing here stands in front of Take out.
 */
import { scanNotes, NoteScanRefused } from "@creaton/core/pot/pot-reads.ts";
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "../../../../ui/button";
import { Card } from "../../../../ui/card";
import type { ProjectNumbers } from "../../../money/numbers";
import { ownNoteSerials } from "../../../pot/own-history";
import { PLAY_MONEY_WORDS } from "../../../pot/pot-words";
import { type Ready, WalletGate } from "../../../pot/use-pot";
import type { Project } from "../../../project/project-record";
import { useTaskJoin } from "../join";
import { claimableNow, nowOf, phaseOf } from "../state";
import { CLAIMS_HEADING_ID } from "./claims-anchor";
import { ClaimSheet } from "./ClaimSheet";
import {
  CLAIMS_HEADING,
  CLAIMS_NEVER_EXPIRE,
  CLAIMS_NONE,
  CLAIMS_NONE_CUT,
  CLAIMS_READ_FAILED,
  claimHeadline,
  claimLine,
  claimPress,
  LOOK_FIRST,
  LOOK_FURTHER,
  LOOK_REFUSED,
  LOOKED_ALL_FOUND,
  LOOKED_ALL_NONE,
  LOOKING,
  lookedBackTo,
  SHOW_MORE,
} from "./notes-words";
import {
  MOST_CANDIDATES,
  type NoteNow,
  noteCandidates,
  readNotes,
} from "./notes-read";

/** Where a look back stands: what it found, how far back it got, and what it last said. */
interface Look {
  found: bigint[];
  /** The lowest block covered, when a look has run. */
  reached: number | null;
  done: boolean;
  status: "none" | "running" | "partial" | "all" | "refused";
  /** The date of the lowest block covered, when the network could say it. */
  at: number | null;
}

const NO_LOOK: Look = {
  found: [],
  reached: null,
  done: false,
  status: "none",
  at: null,
};

/** How many claims the You page shows at first (the Money tab shows them all). */
const FIRST_PAGE = 10;

/** The section behind the sender's gate: connect, switch network, then the list. */
export function NotesCard({
  project,
  numbers,
  projectKey,
  heading,
  anchor = false,
  staged = false,
}: {
  project: Project | null;
  numbers: ProjectNumbers;
  /** The key this browser's history is kept under (the project's chain key). */
  projectKey: string;
  /** The heading's words (the project's name, on the You page). */
  heading?: string;
  /** The Money tab's section is where "Where you claim it" goes: its heading takes focus. */
  anchor?: boolean;
  /** The You page shows the first ten and "Show more". */
  staged?: boolean;
}) {
  return (
    <WalletGate chainId={numbers.chainId} what="see the money you can claim">
      {(ready) => (
        <NotesSection
          anchor={anchor}
          heading={heading}
          numbers={numbers}
          project={project}
          projectKey={projectKey}
          ready={ready}
          staged={staged}
        />
      )}
    </WalletGate>
  );
}

function NotesSection({
  project,
  numbers,
  projectKey,
  ready,
  heading,
  anchor,
  staged,
}: {
  project: Project | null;
  numbers: ProjectNumbers;
  projectKey: string;
  ready: Ready;
  heading: string | undefined;
  anchor: boolean;
  staged: boolean;
}) {
  const titleId = useId();
  const treasury = numbers.contracts.treasury;
  const queue =
    typeof numbers.tasks === "object" && numbers.tasks ? numbers.tasks : null;
  const clock = nowOf(numbers.asOf.time);
  const join = useTaskJoin(project, numbers);
  const [look, setLook] = useState<Look>(NO_LOOK);
  const [shown, setShown] = useState(staged ? FIRST_PAGE : MOST_CANDIDATES);
  const own = ownNoteSerials(ready.address, projectKey);
  const candidates = noteCandidates({
    queue,
    account: ready.address,
    own,
    found: look.found,
  });
  const reading = candidates.slice(0, shown);
  const read = useQuery({
    queryKey: [
      "pot",
      "notes",
      treasury,
      ready.address,
      reading.map(String).join(","),
    ],
    staleTime: 10_000,
    retry: false,
    queryFn: () => readNotes(ready, treasury, reading, clock),
  });
  const [claiming, setClaiming] = useState<bigint | null>(null);
  const [looking, setLooking] = useState(false);

  /** The team's words for a task, by the id the network keeps (the record's id), or null. */
  const wordsOf = (what: string): string | null => {
    if (join.status !== "ready") return null;
    const id = what.slice(2).toLowerCase();
    return (
      join.join.tasks.find((t) => t.task.id.toLowerCase() === id)?.task.what ??
      null
    );
  };

  async function lookBack() {
    if (!queue || looking) return;
    setLooking(true);
    setLook((l) => ({ ...l, status: "running" }));
    const book = queue.book;
    const next = (scan: {
      serials: bigint[];
      reachedBlock: number;
      done: boolean;
    }) => ({
      found: [...new Set([...look.found, ...scan.serials])],
      reached: scan.reachedBlock,
      done: scan.done,
    });
    let result: Look;
    try {
      const scan = await scanNotes(
        ready.wallet,
        book,
        queue.bookBlock,
        ready.address,
        look.reached === null || look.done ? undefined : look.reached - 1,
      );
      result = {
        ...next(scan),
        status: scan.done ? "all" : "partial",
        at: null,
      };
    } catch (error) {
      result =
        error instanceof NoteScanRefused
          ? { ...next(error.found), status: "refused", at: look.at }
          : { ...look, status: "refused" };
    }
    if (result.status === "partial" && result.reached !== null) {
      try {
        result.at = (await ready.wallet.blockTime?.(result.reached)) ?? null;
      } catch {
        result.at = null;
      }
    }
    setLook(result);
    setLooking(false);
  }

  const notes = read.data?.notes ?? [];
  const now = read.data ? Math.max(read.data.time, clock) : clock;
  const cut =
    queue !== null && (queue.truncated || queue.cut.notesRowsDropped > 0);
  const lookWords =
    look.status === "partial"
      ? lookedBackTo(look.at)
      : look.status === "all"
        ? look.found.length === 0
          ? LOOKED_ALL_NONE
          : LOOKED_ALL_FOUND
        : look.status === "refused"
          ? LOOK_REFUSED
          : null;
  const claimNote = notes.find((n) => n.serial === claiming) ?? null;

  // On the Money tab the heading is "Money you can claim" and takes focus when a sheet sends a person here; on You, where a
  // group heading says it, each project's own name heads its part.
  const headingId = anchor ? CLAIMS_HEADING_ID : titleId;
  return (
    <section
      aria-labelledby={headingId}
      className="glass glass-text flex flex-col gap-3 rounded-2xl p-4"
      data-testid="notes-section"
    >
      {heading ? (
        <h4 className="text-base font-semibold" id={headingId}>
          {heading}
        </h4>
      ) : (
        <h2
          className="headline text-xl"
          id={headingId}
          tabIndex={anchor ? -1 : undefined}
        >
          {CLAIMS_HEADING}
        </h2>
      )}
      <p className="text-sm text-muted" data-testid="notes-never-expire">
        {CLAIMS_NEVER_EXPIRE}
      </p>
      {read.isPending ? (
        <Card className="h-16 animate-pulse" data-testid="notes-reading" />
      ) : read.isError ? (
        <div className="flex flex-col gap-2" data-testid="notes-read-failed">
          <p className="text-sm">{CLAIMS_READ_FAILED}</p>
          <Button onClick={() => void read.refetch()} variant="secondary">
            Try again
          </Button>
        </div>
      ) : notes.length === 0 ? (
        <p className="text-sm" data-testid="notes-none">
          {cut ? CLAIMS_NONE_CUT : CLAIMS_NONE}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="notes-list">
          {notes.map((note) => (
            <NoteRow
              key={note.serial.toString()}
              now={now}
              note={note}
              onClaim={() => setClaiming(note.serial)}
              windDownAt={numbers.windDown?.at ?? null}
              what={wordsOf(note.task.what)}
            />
          ))}
        </ul>
      )}
      {candidates.length > shown ? (
        <Button
          data-testid="notes-show-more"
          onClick={() => setShown((n) => n + FIRST_PAGE)}
          variant="secondary"
        >
          {SHOW_MORE}
        </Button>
      ) : null}
      {queue ? (
        <div className="flex flex-col items-start gap-1">
          <Button
            data-testid="notes-look"
            disabled={looking}
            onClick={() => void lookBack()}
            variant="ghost"
          >
            {looking
              ? LOOKING
              : look.status === "partial"
                ? LOOK_FURTHER
                : LOOK_FIRST}
          </Button>
          <p
            aria-live="polite"
            className="text-sm"
            data-testid="notes-look-words"
          >
            {lookWords}
          </p>
        </div>
      ) : null}
      {mustSayPlayMoney(numbers.playMoney) ? (
        <p className="text-sm text-muted" data-testid="notes-play-money">
          {PLAY_MONEY_WORDS}
        </p>
      ) : null}
      {claiming !== null ? (
        <ClaimSheet
          numbers={numbers}
          onClose={() => setClaiming(null)}
          open
          ready={ready}
          serial={claiming}
          what={claimNote ? wordsOf(claimNote.task.what) : null}
        />
      ) : null}
    </section>
  );
}

function NoteRow({
  note,
  now,
  windDownAt,
  what,
  onClaim,
}: {
  note: NoteNow;
  now: number;
  windDownAt: number | null;
  what: string | null;
  onClaim: () => void;
}) {
  const phase = phaseOf(note.task, now, windDownAt);
  const running = phase === "working";
  const overdue = phase === "overdue";
  const claimable = overdue
    ? note.face
    : claimableNow(note.task, note.face, now);
  const paidInFull = note.task.state === "paid" && note.task.returned === 0n;
  const id = useId();
  return (
    <li
      aria-labelledby={id}
      className="flex flex-col gap-1"
      data-testid="notes-row"
    >
      <p className="break-words font-semibold" id={id}>
        {claimHeadline({ what, setAside: note.task.setAside, running })}
      </p>
      <p className="break-words text-sm" data-testid="notes-row-line">
        {claimLine({ phase, face: note.face, claimable, paidInFull })}
      </p>
      {claimable > 0n ? (
        <div>
          <Button
            data-testid="notes-claim"
            onClick={onClaim}
            size="sm"
            variant="secondary"
          >
            {claimPress(claimable)}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
