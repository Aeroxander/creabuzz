import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip } from "@/shared/ui/chip";
import { Input } from "@/shared/ui/input";
import {
  caseActions,
  type CourtCase,
  commitHash,
  encodeAppealCase,
  encodeCommit,
  encodeDraw,
  encodeEvidence,
  encodeExecute,
  encodePassPeriod,
  encodeReveal,
  encodeDeliverRuling,
  encodeTimeout,
  sealedChoice,
} from "@creaton/core/launchpad/court.ts";
import {
  caseKind,
  caseQuestion,
  caseStatusLine,
  timeoutLabel,
} from "../lib/court-copy";
import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import { evidenceLink } from "../lib/post-bounty-copy";
import {
  keepVoteKey,
  keptVoteKey,
  parseVoteKey,
  voteKeyName,
} from "../lib/vote-key";
import { encodeApproveBounty } from "@creaton/core/launchpad/workBounty.ts";
import type { ConnectedWalletState } from "../use-connected-wallet";
import { type CourtPageData, voteSalt } from "../use-court";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** One case: what it is about, where it stands, and the one step it allows now. */
export function CourtCaseCard({
  kase,
  data,
  wallet,
  busy,
  gate,
  onSend,
}: {
  kase: CourtCase;
  data: CourtPageData;
  wallet: ConnectedWalletState;
  busy: string | null;
  gate: string | null;
  onSend: Send;
}) {
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [evidence, setEvidence] = useState("");
  // The vote key just used to seal, shown to copy; and one pasted back when this browser lost it.
  const [sealedKey, setSealedKey] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pastedKey, setPastedKey] = useState("");
  const key = kase.id.toString();
  const round = kase.rounds - 1;
  const can = caseActions(kase, data.freeSeats, data.now);
  const blocked = busy !== null || gate !== null || signing;
  const about = data.about[key];
  const remix = data.remix[key];
  const kind = caseKind(kase);
  const ask = caseQuestion(kind);
  const send = (name: string, call: string, to = data.court) =>
    onSend(`court-${name}-${key}`, to, call);
  const keyName = (me: string) => voteKeyName(data.court, kase.id, round, me);

  const withSecret = async (
    use: (salt: string, me: string) => Promise<void>,
  ) => {
    setProblem(null);
    const me = wallet.address;
    if (!me) return;
    setSigning(true);
    try {
      const salt = await voteSalt(wallet, data.court, kase.id, round);
      setSigning(false);
      await use(salt, me);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSigning(false);
    }
  };
  const seal = (choice: 1 | 2) =>
    withSecret(async (salt, me) => {
      // Kept before sending, so a seal that lands is never without its key here.
      const kept = keepVoteKey(keyName(me), salt);
      if (
        await send(
          "seal",
          encodeCommit(kase.id, commitHash(choice, salt, me, kase.id, round)),
        )
      ) {
        setSealedKey(salt);
        if (!kept) {
          setProblem(
            "This browser could not keep your vote key. Copy it below: you need it to open your vote.",
          );
        }
      }
    });
  const reveal = async (salt: string, me: string) => {
    const choice = sealedChoice(
      kase.mine?.commit ?? "",
      salt,
      me,
      kase.id,
      round,
    );
    if (choice === null) return false;
    await send("open", encodeReveal(kase.id, choice, salt));
    return true;
  };
  const open = async () => {
    setProblem(null);
    const me = wallet.address;
    if (!me) return;
    // The key kept when sealing, then a fresh signature (wallets that sign the same way twice), then a pasted one.
    const kept = keptVoteKey(keyName(me));
    if (kept && (await reveal(kept, me))) return;
    await withSecret(async (salt) => {
      if (!(await reveal(salt, me))) {
        setPasting(true);
        setProblem(
          "Your approval doesn't open the seal, and this browser has no key for it. Paste the vote key you copied when you sealed, or use the browser you sealed in.",
        );
      }
    });
  };
  const openWithPasted = async () => {
    setProblem(null);
    const me = wallet.address;
    const salt = parseVoteKey(pastedKey);
    if (!me) return;
    if (!salt) {
      setProblem("A vote key is 64 letters and digits after 0x.");
      return;
    }
    if (!(await reveal(salt, me))) {
      setProblem("That key does not open this vote. Check it is this case's.");
      return;
    }
    keepVoteKey(keyName(me), salt);
  };
  const appeal = async () => {
    setProblem(null);
    if (!data.wallet) return;
    if (data.wallet.fee < kase.appealCost) {
      setProblem(
        `An appeal costs ${formatUnits(kase.appealCost, 6)} USDC. You have ${formatUnits(data.wallet.fee, 6)}.`,
      );
      return;
    }
    if (data.wallet.feeAllowance < kase.appealCost) {
      const allowed = await send(
        "appeal-allow",
        encodeApproveBounty(data.court, kase.appealCost),
        data.feeToken,
      );
      if (!allowed) return;
    }
    await send("appeal", encodeAppealCase(kase.id));
  };
  const submitEvidence = async () => {
    setProblem(null);
    try {
      if (await send("evidence", encodeEvidence(kase.id, evidence)))
        setEvidence("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const evidenceUrl = about?.evidence ? evidenceLink(about.evidence) : null;

  return (
    <Card
      className="flex flex-col gap-2 p-4 text-sm"
      data-testid="court-case"
      id={`case-${key}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">
          Case {key}
          {kase.about?.kind === "bounty"
            ? ` · a bounty's claim ${kase.about.claim}`
            : kase.about?.kind === "remix"
              ? " · a remix's bond"
              : ""}
        </p>
        {kase.assigned ? (
          <Chip tone="info">
            <span data-testid="court-case-assigned">You are on this case</span>
          </Chip>
        ) : null}
      </div>
      <p className="font-medium" data-testid="court-case-question">
        {ask.question}
      </p>
      {kind === "remix" ? (
        <p data-testid="court-case-terms">
          <span className="text-muted-foreground">The terms: </span>
          {remix?.terms ?? "The terms could not be read."}
          {remix ? (
            <span className="text-muted-foreground">
              {" "}
              · bond {formatUnits(remix.amount, 18)} CREATE
            </span>
          ) : null}
        </p>
      ) : null}
      {about ? (
        <>
          <p data-testid="court-case-words">
            <span className="text-muted-foreground">Done looks like: </span>
            {about.words ?? "The words could not be read."}
          </p>
          <p className="break-words" data-testid="court-case-evidence">
            <span className="text-muted-foreground">The work: </span>
            {evidenceUrl ? (
              <a
                className="underline"
                href={evidenceUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {about.evidence}
              </a>
            ) : (
              (about.evidence ?? "The submission could not be read.")
            )}
          </p>
          {about.post ? (
            <Link
              className="underline"
              params={{ id: about.post.replace(/^0x/, "") }}
              to="/social/post/$id"
            >
              Open the post
            </Link>
          ) : null}
        </>
      ) : null}
      <p data-testid="court-case-status">
        {caseStatusLine({ ...kase, kind }, date)}
      </p>
      {kase.evidence.length > 0 ? (
        <div data-testid="court-case-evidence-list">
          <p className="text-xs font-medium text-muted-foreground">
            Evidence given
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {kase.evidence.map((e, i) => {
              const link = evidenceLink(e.text);
              return (
                // Evidence never changes once given, so its place in the list is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
                <li className="break-words" key={i}>
                  <span className="text-muted-foreground">
                    {e.party.slice(0, 6)}…{e.party.slice(-4)}:{" "}
                  </span>
                  {link ? (
                    <a
                      className="underline"
                      href={link}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {e.text}
                    </a>
                  ) : (
                    e.text
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {kase.period !== "ruled" && kase.round.drawn.length > 0 ? (
        <p className="text-muted-foreground" data-testid="court-case-round">
          Round {kase.rounds} of 3 · {kase.round.seats} seats ·{" "}
          {kase.round.committed} of {kase.round.drawn.length} jurors sealed
          their vote · {kase.round.revealed} opened
          {kase.mine && kase.mine.seats > 0
            ? ` · you hold ${kase.mine.seats} ${kase.mine.seats === 1 ? "seat" : "seats"}`
            : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {can.draw ? (
          <Button
            data-testid="court-draw"
            disabled={blocked}
            onClick={() => void send("draw", encodeDraw(kase.id))}
            size="sm"
            type="button"
          >
            Draw the jurors
          </Button>
        ) : null}
        {can.seal ? (
          <>
            <Button
              data-testid="court-seal-for"
              disabled={blocked}
              onClick={() => void seal(1)}
              size="sm"
              type="button"
            >
              Seal my vote: {ask.yes}
            </Button>
            <Button
              data-testid="court-seal-against"
              disabled={blocked}
              onClick={() => void seal(2)}
              size="sm"
              type="button"
              variant="outline"
            >
              Seal my vote: {ask.no}
            </Button>
          </>
        ) : null}
        {can.open ? (
          <Button
            data-testid="court-open"
            disabled={blocked}
            onClick={() => void open()}
            size="sm"
            type="button"
          >
            Open my vote
          </Button>
        ) : null}
        {can.moveOn ? (
          <Button
            data-testid="court-move-on"
            disabled={blocked}
            onClick={() => void send("move-on", encodePassPeriod(kase.id))}
            size="sm"
            type="button"
            variant="outline"
          >
            Move on
          </Button>
        ) : null}
        {can.appeal ? (
          <Button
            data-testid="court-appeal"
            disabled={blocked}
            onClick={() => void appeal()}
            size="sm"
            type="button"
            variant="outline"
          >
            Appeal to {kase.round.seats * 2 + 1} jurors (
            {formatUnits(kase.appealCost, 6)} USDC)
          </Button>
        ) : null}
        {can.settle ? (
          <Button
            data-testid="court-settle"
            disabled={blocked}
            onClick={() => void send("settle", encodeExecute(kase.id))}
            size="sm"
            type="button"
          >
            Settle the case
          </Button>
        ) : null}
        {can.timeout ? (
          <Button
            data-testid="court-timeout"
            disabled={blocked}
            onClick={() => void send("timeout", encodeTimeout(kase.id))}
            size="sm"
            type="button"
            variant="outline"
          >
            {timeoutLabel(kase.rounds)}
          </Button>
        ) : null}
        {can.deliver ? (
          <Button
            data-testid="court-deliver"
            disabled={blocked}
            onClick={() => void send("deliver", encodeDeliverRuling(kase.id))}
            size="sm"
            type="button"
          >
            Hand over the ruling
          </Button>
        ) : null}
      </div>
      {can.seal ? (
        <p className="text-xs text-muted-foreground">
          You approve a message to seal your vote. Nobody sees which way you
          voted until the votes are opened. This browser keeps the key that
          opens it.
        </p>
      ) : null}
      {sealedKey ? (
        <div className="flex flex-col gap-1" data-testid="court-vote-key">
          <p className="text-xs text-muted-foreground">
            Your vote key. Keep a copy if you might open your vote from another
            browser:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all text-xs">{sealedKey}</code>
            <Button
              data-testid="court-vote-key-copy"
              onClick={() =>
                void navigator.clipboard?.writeText(sealedKey).catch(() => {})
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Copy
            </Button>
          </div>
        </div>
      ) : null}
      {pasting && can.open ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex grow flex-col gap-1">
            <label className="text-xs font-medium" htmlFor={`${id}-key`}>
              Vote key
            </label>
            <Input
              data-testid="court-vote-key-paste"
              id={`${id}-key`}
              onChange={(e) => setPastedKey(e.target.value)}
              placeholder="0x…"
              value={pastedKey}
            />
          </div>
          <Button
            data-testid="court-vote-key-open"
            disabled={blocked || !pastedKey.trim()}
            onClick={() => void openWithPasted()}
            size="sm"
            type="button"
          >
            Open with this key
          </Button>
        </div>
      ) : null}
      {kase.period !== "ruled" ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex grow flex-col gap-1">
            <label className="text-xs font-medium" htmlFor={`${id}-evidence`}>
              Add evidence
            </label>
            <Input
              data-testid="court-evidence"
              id={`${id}-evidence`}
              maxLength={1000}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="A link or a short note for the jurors"
              value={evidence}
            />
          </div>
          <Button
            data-testid="court-evidence-submit"
            disabled={blocked || !evidence.trim()}
            onClick={() => void submitEvidence()}
            size="sm"
            type="button"
            variant="outline"
          >
            Add
          </Button>
        </div>
      ) : null}
      {problem ? (
        <p
          className="text-red-700 dark:text-red-300"
          data-testid="court-case-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </Card>
  );
}
