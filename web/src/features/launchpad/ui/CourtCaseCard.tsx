import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
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
  encodeTimeout,
  sealedChoice,
} from "../lib/court";
import { caseStatusLine } from "../lib/court-copy";
import { formatUnits } from "../lib/dao-actions";
import { evidenceLink } from "../lib/post-bounty-copy";
import { encodeApproveBounty } from "../lib/work-bounty";
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
  const key = kase.id.toString();
  const round = kase.rounds - 1;
  const can = caseActions(kase, data.freeSeats, data.now);
  const blocked = busy !== null || gate !== null || signing;
  const about = data.about[key];
  const send = (name: string, call: string, to = data.court) =>
    onSend(`court-${name}-${key}`, to, call);

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
      await send(
        "seal",
        encodeCommit(kase.id, commitHash(choice, salt, me, kase.id, round)),
      );
    });
  const open = () =>
    withSecret(async (salt, me) => {
      const choice = sealedChoice(
        kase.mine?.commit ?? "",
        salt,
        me,
        kase.id,
        round,
      );
      if (choice === null) {
        setProblem(
          "This wallet's signature doesn't open the seal. Use the wallet you sealed with.",
        );
        return;
      }
      await send("open", encodeReveal(kase.id, choice, salt));
    });
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
      <p className="font-semibold">
        Case {key}
        {kase.about ? ` · a bounty's claim ${kase.about.claim}` : ""}
      </p>
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
              (about.evidence ?? "The claim could not be read.")
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
      <p data-testid="court-case-status">{caseStatusLine(kase, date)}</p>
      {kase.period !== "ruled" && kase.round.drawn.length > 0 ? (
        <p className="text-muted-foreground" data-testid="court-case-round">
          Round {kase.rounds} of 3 · {kase.round.seats} seats ·{" "}
          {kase.round.committed} of {kase.round.drawn.length} sealed ·{" "}
          {kase.round.revealed} opened
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
              Seal my vote: for the work
            </Button>
            <Button
              data-testid="court-seal-against"
              disabled={blocked}
              onClick={() => void seal(2)}
              size="sm"
              type="button"
              variant="outline"
            >
              Seal my vote: against
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
            End it with no ruling
          </Button>
        ) : null}
      </div>
      {can.seal ? (
        <p className="text-xs text-muted-foreground">
          Your wallet signs a message to seal the vote; nobody sees which way
          you voted until the votes are opened. Open it later with the same
          wallet.
        </p>
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
