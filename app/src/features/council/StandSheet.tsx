/**
 * The stand sheet (`docs/next-version/COUNCIL-PLAN.md` section 6.2): one sheet for the three things a person can put
 * forward in a vote — themselves for a seat, a list of five accounts for a replace vote, or the vote itself (opening a
 * replace vote with their own list).
 *
 * One press does two steps: the app signs a short text (a `candidacy` record, so the words can never be swapped after the
 * vote stored their hash) and then sends the chain call that carries the record's id. A failure after the text was signed
 * keeps that id in the sheet's state, so pressing again sends it without signing a second time. Refusals are said in the
 * copy modules' plain words, never a contract's error name; the words are the plan's own where it fixes them (the label,
 * the promise line, the public line, the banner, the opening sentence built from `vote.rule`).
 *
 * The five fields take an account the project already shows (its linked name) or a pasted address, and say what they
 * understood: Tab moves, Enter adds and moves on, and a paste of five addresses fills all five.
 */
import { KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";
import {
  openReplaceCall,
  standCall,
  standListCall,
} from "@creaton/core/pot/pot-calls.ts";
import { asBigint, ask } from "@creaton/core/pot/pot-reads.ts";
import { HOLDER_VOTE_ABI } from "@creaton/core/pot/abis.generated.ts";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { publishAsUser } from "../../lib/relay";
import { Button } from "../../ui/button";
import { Field, TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { BannerText } from "../../app/MoneyBanner";
import type { ProjectNumbers } from "../money/numbers";
import { useMoneySend } from "../money/use-money";
import { WalletGate, type Ready } from "../pot/use-pot";
import {
  refusalOf,
  refusalWords,
  REFUSAL_FALLBACK,
  seatFieldLabel,
} from "./council-words";
import { openVoteSentence, PUBLIC_LINE } from "./vote-words";

/** The most characters the short text may hold (the plan's 280, and the record's own limit). */
const TEXT_MAX = 280;
/** How long a signed text may stand for: a week, well inside the plan's 30 days. */
const TEXT_LIVES_SECS = 7 * 86_400;
/** The five accounts of a list, in the list's own seat order. */
const SEATS = 5;

export type StandMode = "person" | "list" | "open";

const PRESS: Record<StandMode, string> = {
  person: "Stand",
  list: "Put forward this list",
  open: "Open the vote",
};

const TITLE: Record<StandMode, string> = {
  person: "Stand for a seat",
  list: "Put forward a list",
  open: "Open the vote",
};

const SHORT = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A count of the text, said as a live line a screen reader hears while it changes. */
function LiveCount({ used }: { used: number }) {
  return (
    <p
      aria-live="polite"
      className="num text-sm text-muted"
      data-testid="stand-count"
    >
      {used} of {TEXT_MAX} characters
    </p>
  );
}

/** What a failed first step says: the text was not posted, the reason mapped to plain words, never a server's name. */
function postProblem(error: unknown): string {
  const said = error instanceof Error ? error.message : "";
  if (/linked/i.test(said))
    return "Your text was not posted: this account has not linked the wallet you stand with. Link it in your profile, then try again. Nothing was sent.";
  if (/\bagent\b|helper/i.test(said))
    return "This account is marked as a helper. A person has to stand. Nothing was sent.";
  return "Your text was not posted, so nothing was sent. Try again in a moment.";
}

function StandForm({
  mode,
  numbers,
  now,
  projectCoordinate,
  ready,
  onClose,
  nameOf,
}: {
  mode: StandMode;
  numbers: ProjectNumbers;
  now: number;
  projectCoordinate: string | null;
  ready: Ready;
  onClose: () => void;
  /** A name for an account, as the page shows accounts (a linked name, else a short address). */
  nameOf: (address: string) => string;
}) {
  const vote = numbers.vote ?? null;
  const open = vote?.open ?? null;
  const rule = vote?.rule ?? null;
  const queryClient = useQueryClient();
  const toast = useToast();
  const send = useMoneySend(`stand:${numbers.chainId}:${vote?.contract ?? ""}`);
  const [text, setText] = useState("");
  const [fields, setFields] = useState<string[]>(
    Array.from({ length: SEATS }, () => ""),
  );
  /** The signed text's id, kept after a failed second step so pressing again sends it without signing again. */
  const [signed, setSigned] = useState<{ id: string; key: string } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The accounts a field can name: the project's holders and the runner, as the page already shows them.
  const known: { address: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const holder of numbers.holders) {
    const address = holder.account.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    known.push({ address, name: nameOf(holder.account) });
  }
  const runner = numbers.runner.address.toLowerCase();
  if (!seen.has(runner))
    known.unshift({ address: runner, name: nameOf(runner) });

  const resolve = (value: string): string | null => {
    const clean = value.trim().toLowerCase();
    if (ADDRESS.test(clean)) return clean;
    if (clean === "") return null;
    return known.find((k) => k.name.toLowerCase() === clean)?.address ?? null;
  };
  const resolved = fields.map(resolve);
  const five = resolved.filter(
    (address): address is string => address !== null,
  );
  const distinct = new Set(five).size === five.length;
  const listReady =
    mode === "person" ? true : five.length === SEATS && distinct;
  const textReady = text.trim() !== "";
  const canPress =
    listReady && textReady && !busy && projectCoordinate !== null;

  /** A second step's refusal, in the plan's own table's words. */
  const sendProblem = (error: unknown): string => {
    if (!vote) return REFUSAL_FALLBACK;
    const press =
      mode === "person"
        ? "stand"
        : mode === "list"
          ? "stand-list"
          : "open-replace";
    const refusal = refusalOf(error, press, open?.phase ?? null);
    if (!refusal) return REFUSAL_FALLBACK;
    return refusalWords(
      refusal,
      { rule: vote.rule, phase: open?.phase ?? null },
      open?.standEnd ?? null,
    );
  };

  /** The text record's id the chain will store: its own signature's id, signed before the call. */
  const sign = async (ballotId: number): Promise<string> => {
    if (!vote) throw new Error("no vote");
    const members = mode === "person" ? [ready.address] : (five as string[]);
    const tags: string[][] = [
      ["a", projectCoordinate as string],
      ["candidacy", String(ballotId)],
      ["t", `vote:${numbers.key.toLowerCase()}:${ballotId}`],
      ["proposer", ready.address.toLowerCase()],
      ...members.map((account) => ["candidate", account]),
      ["expiration", String(Math.floor(now) + TEXT_LIVES_SECS)],
    ];
    const posted = await publishAsUser(
      {
        kind: KIND_LAUNCH_UPDATE,
        tags,
        content: JSON.stringify({ v: 1, text: text.trim() }),
      },
      "Your text was not posted. Nothing was sent.",
    );
    return posted.id;
  };

  /** The ballot an opening vote will get, read from the vote contract itself. */
  const nextBallot = async (): Promise<number> => {
    if (!vote) throw new Error("no vote");
    const [id] = await ask(
      ready.read,
      HOLDER_VOTE_ABI,
      vote.contract,
      "nextBallot",
      [],
    );
    const number = Number(asBigint(id));
    if (!Number.isInteger(number) || number < 1 || number > 0xffff_ffff)
      throw new Error("unreadable");
    return number;
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canPress || busy || !vote || projectCoordinate === null) return;
    setBusy(true);
    setProblem(null);
    const signedKey = `${mode}|${text.trim()}|${resolved.join(",")}`;
    let hash = signed?.key === signedKey ? signed.id : null;
    if (hash === null) {
      try {
        const ballotId = mode === "open" ? await nextBallot() : (open?.id ?? 0);
        if (ballotId === 0) {
          setProblem(
            "This vote is not open now. Nothing was sent. Look at the project page for where it stands.",
          );
          return;
        }
        hash = await sign(ballotId);
        setSigned({ id: hash, key: signedKey });
      } catch (error) {
        setProblem(postProblem(error));
        return;
      }
    }
    const call =
      mode === "person"
        ? standCall(vote.contract, hash)
        : mode === "list"
          ? standListCall({
              vote: vote.contract,
              members: five,
              recordHash: hash,
            })
          : openReplaceCall({
              vote: vote.contract,
              members: five,
              recordHash: hash,
            });
    try {
      await send.sendAsync({
        chainId: numbers.chainId,
        build: () => [call],
      });
      toast(
        mode === "open"
          ? "The vote is open. Holders vote from the end of the first day."
          : "Your name is in this vote.",
        "done",
      );
      void queryClient.invalidateQueries({ queryKey: ["money"] });
      void queryClient.invalidateQueries({ queryKey: ["pot"] });
      onClose();
    } catch (error) {
      setProblem(sendProblem(error));
    } finally {
      setBusy(false);
    }
  };

  /** Moves to the next field of the same form (Tab does it on its own; Enter adds and moves on). */
  const move = (from: HTMLInputElement, step: number) => {
    const form = from.form;
    if (!form) return;
    const all = Array.from(
      form.querySelectorAll<HTMLInputElement>("[data-seat]"),
    );
    const at = all.indexOf(from);
    all[at + step]?.focus();
  };

  /** A paste of five accounts fills all five fields; anything else is left to the box to take. */
  const paste = (event: React.ClipboardEvent) => {
    const parts = event.clipboardData
      .getData("text")
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < SEATS) return;
    const next = [...fields];
    for (let i = 0; i < SEATS; i += 1) next[i] = parts[i] as string;
    const addresses = next.map(resolve);
    if (addresses.some((address) => address === null)) return;
    event.preventDefault();
    setFields(next);
  };

  const duplicate = fields.some((_value, i) => {
    const mine = resolved[i];
    return mine !== null && resolved.indexOf(mine) !== i;
  });
  let note: string | null = null;
  if (signed !== null)
    note = "Your text is signed. Press again to send it; nothing was sent yet.";

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <TextArea
          data-testid="stand-text"
          hint="Your words, up to 280 characters."
          label="Say in a few words who you are and what you would do"
          maxLength={TEXT_MAX}
          onChange={(event) => setText(event.target.value)}
          rows={3}
          value={text}
        />
        <LiveCount used={text.length} />
        <p className="text-sm text-muted" data-testid="stand-promise">
          Do not promise anyone a profit or a return.
        </p>
      </div>

      {mode !== "person" ? (
        <div className="flex flex-col gap-2">
          {fields.map((value, i) => {
            const address = resolved[i] ?? null;
            const problemHere =
              duplicate && address !== null
                ? "A list needs five different accounts."
                : value.trim() !== "" && address === null
                  ? "Not one of the project's accounts. Paste its address."
                  : null;
            return (
              <Field
                autoComplete="off"
                data-seat={String(i)}
                data-testid={`stand-seat-${i + 1}`}
                hint={
                  address
                    ? `${nameFor(known, address)} · ${SHORT(address)}`
                    : "An account's name, or its pasted address."
                }
                key={seatFieldLabel(i)}
                label={seatFieldLabel(i)}
                onChange={(event) =>
                  setFields((before) => {
                    const next = [...before];
                    next[i] = event.target.value;
                    return next;
                  })
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  move(event.currentTarget, 1);
                }}
                onPaste={paste}
                problem={problemHere}
                spellCheck={false}
                value={value}
              />
            );
          })}
        </div>
      ) : null}

      <p className="text-sm text-muted" data-testid="stand-no-removal">
        You cannot take your name off once you stand.
      </p>
      {mode === "open" && rule ? (
        <p className="text-sm" data-testid="stand-opening">
          {openVoteSentence(rule)}
        </p>
      ) : null}
      <p className="text-sm text-muted" data-testid="stand-public">
        {PUBLIC_LINE}
      </p>
      <BannerText testId="stand-banner" />
      {note ? (
        <p className="text-sm" data-testid="stand-signed">
          {note}
        </p>
      ) : null}
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="stand-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {/* A press that cannot run says why: a dead press with no reason is the one thing this sheet must not do. */}
      {!canPress && !textReady ? (
        <p className="text-sm text-muted" data-testid="stand-needs-words">
          Write your words above to stand.
        </p>
      ) : null}
      <Button
        block
        data-testid="stand-confirm"
        disabled={!canPress}
        type="submit"
      >
        {send.isPending ? send.words.waiting : PRESS[mode]}
      </Button>
    </form>
  );
}

function nameFor(
  known: readonly { address: string; name: string }[],
  address: string,
): string {
  return known.find((k) => k.address === address)?.name ?? SHORT(address);
}

/** The sheet: the three modes open on the same words and presses, and one press signs then sends. */
export function StandSheet({
  open,
  onClose,
  mode,
  numbers,
  now,
  projectCoordinate,
  nameOf,
}: {
  open: boolean;
  onClose: () => void;
  mode: StandMode;
  /** The record with its milestone 9 keys read. */
  numbers: ProjectNumbers;
  now: number;
  /** The project's coordinate, for the record the text is signed as; `null` sends nothing. */
  projectCoordinate: string | null;
  /** A name for an account, as the page shows accounts (a linked name, else a short address). */
  nameOf: (address: string) => string;
}) {
  return (
    <Sheet
      description="Your text is signed first, then sent. Nothing is public until you press."
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      testId="stand-sheet"
      title={TITLE[mode]}
    >
      <WalletGate chainId={numbers.chainId} what="stand in this vote">
        {(ready) => (
          <StandForm
            mode={mode}
            now={now}
            numbers={numbers}
            nameOf={nameOf}
            onClose={onClose}
            projectCoordinate={projectCoordinate}
            ready={ready}
          />
        )}
      </WalletGate>
    </Sheet>
  );
}
