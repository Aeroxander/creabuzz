/**
 * Suggested work (D84): anyone can suggest a piece of work for this project and name their price, in Shares or as a
 * share of the project, and any holder can put it to a vote as "Approve a work area", filled in from the suggestion.
 * Suggesting pays nothing: once approved, the person who suggested it files claims like anyone, the reviewers judge
 * them, and the project votes each award.
 *
 * A suggestion is a board post, so it can be discussed and voted up and down like any other, on its board and in
 * Home's timeline.
 */

import { Link } from "@tanstack/react-router";
import { CheckCircle2, Lightbulb } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { usePostToBoard } from "@/features/board/use-post-to-board";
import { needAccountTo } from "@/features/identity/lib/account-copy";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { shortRelativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { askForShare, proposalProblem, shareAfter } from "../lib/work-proposal";
import {
  cannotOpenDecision,
  type ProposalPower,
  whoMayOpen,
} from "../lib/proposal-gate";
import type { SponsorIntent } from "../lib/sponsor";
import { type ProposalRow, useWorkProposals } from "../use-work-proposals";
import { TextAreaField, TextField } from "./decision-fields";

const WAD = 10n ** 18n;

function formatWhole(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBps(bps: number): string {
  const tenths = Math.round(bps / 10);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

/** Whole Shares that exist now, from the 18-decimal total; null when it could not be read. */
function wholeSupply(totalShares: bigint | null): bigint | null {
  return totalShares === null ? null : totalShares / WAD;
}

function SuggestForm({
  supplyWhole,
  onSuggest,
  onDone,
}: {
  supplyWhole: bigint | null;
  onSuggest: ReturnType<typeof useWorkProposals>["suggest"];
  onDone: () => void;
}) {
  const { boards, loading: boardsLoading } = usePostToBoard();
  // Until the boards are read, "there is no board" would be a guess.
  const waitingForBoards = boardsLoading && boards.length === 0;
  const [boardId, setBoardId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [check, setCheck] = useState("");
  const [unit, setUnit] = useState<"shares" | "percent">("percent");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const board = boardId || boards[0]?.id || "";
  // The ask in Shares, from what was typed: Shares as they are, or a share of the project once they are added.
  const ask = useMemo<bigint | null>(() => {
    const text = amount.trim().replace(/[,_\s%]/g, "");
    if (text === "") return null;
    if (unit === "shares") return /^\d+$/.test(text) ? BigInt(text) : null;
    const pct = Number(text);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100 || supplyWhole === null)
      return null;
    return askForShare(Math.round(pct * 100), supplyWhole);
  }, [amount, unit, supplyWhole]);

  const submit = async () => {
    if (!board) {
      setProblem(
        "There is no board on this server to post it on yet. Start one on Home's Boards tab first.",
      );
      return;
    }
    if (ask === null) {
      setProblem(
        unit === "percent"
          ? "Type the share you ask for, between 0 and 100."
          : "Type the Shares you ask for, as a whole number.",
      );
      return;
    }
    const found = proposalProblem({ title, body, name, askWhole: ask, check });
    if (found) {
      setProblem(found);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSuggest({
        boardId: board,
        title,
        body,
        name,
        askWhole: ask,
        check,
      });
      toast.success("Suggested. Holders can now put it to a vote.");
      onDone();
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Couldn't post that. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="suggest-work-form">
      <TextField
        label="What you will do"
        onChange={setTitle}
        placeholder="e.g. Translate the docs to Spanish"
        testId="suggest-title"
        value={title}
      />
      <TextAreaField
        hint="How you will do it, and anything people should know."
        label="Details"
        onChange={setBody}
        testId="suggest-body"
        value={body}
      />
      <TextField
        hint="A word or two; the work area's name if it is approved."
        label="Short name"
        onChange={setName}
        placeholder="e.g. Spanish guide"
        testId="suggest-name"
        value={name}
      />
      <TextAreaField
        hint="The reviewers will check your work against these words."
        label="What finished work looks like"
        onChange={setCheck}
        placeholder="e.g. All twelve pages are translated and published"
        testId="suggest-check"
        value={check}
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40">
          <TextField
            inputMode="decimal"
            label="You ask for"
            onChange={setAmount}
            placeholder={unit === "percent" ? "e.g. 5" : "e.g. 5000"}
            testId="suggest-amount"
            value={amount}
          />
        </div>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">Ask in</legend>
          <div className="flex rounded-md border p-0.5">
            {(["percent", "shares"] as const).map((key) => (
              <button
                aria-pressed={unit === key}
                className={`rounded px-2.5 py-1 text-xs font-medium ${unit === key ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
                data-testid={`suggest-unit-${key}`}
                key={key}
                onClick={() => setUnit(key)}
                type="button"
              >
                {key === "percent" ? "% of the project" : "Shares"}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <p
        className="text-xs text-muted-foreground"
        data-testid="suggest-ask-preview"
      >
        {ask === null
          ? unit === "percent" && supplyWhole === null
            ? "The project's Shares could not be read just now, so a percent cannot be worked out. Ask in Shares instead."
            : "Type what you ask for."
          : supplyWhole === null
            ? `${formatWhole(ask)} Shares.`
            : `${formatWhole(ask)} Shares: ${formatBps(shareAfter(ask, supplyWhole))} of the project once they are added to the ${formatWhole(supplyWhole)} that exist now, so everyone else's part shrinks by that much.`}
      </p>
      {boards.length > 1 ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Post on</span>
          <select
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            data-testid="suggest-board"
            onChange={(e) => setBoardId(e.target.value)}
            value={board}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.joined ? " (joined)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {problem ? (
        <p
          className="text-sm text-destructive"
          data-testid="suggest-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="suggest-submit"
          disabled={busy || waitingForBoards}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {busy
            ? "Posting…"
            : waitingForBoards
              ? "Reading boards…"
              : "Suggest it"}
        </Button>
        <Button
          disabled={busy}
          onClick={onDone}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ProposalCard({
  row,
  name,
  supplyWhole,
  onSponsor,
  vote,
  onSeeVote,
}: {
  row: ProposalRow;
  name: string;
  supplyWhole: bigint | null;
  onSponsor?: (intent: SponsorIntent) => void;
  /** The open vote that would approve it, when there is one. */
  vote: string | null;
  onSeeVote?: (decisionId: string) => void;
}) {
  return (
    <li
      className="rounded-lg border p-3"
      data-status={row.status}
      data-testid={`work-proposal-${row.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          className="font-semibold hover:underline"
          params={{ boardId: row.boardId }}
          search={{ post: row.id }}
          to="/b/$boardId"
        >
          {row.title}
        </Link>
        <span
          className="text-sm font-semibold tabular-nums"
          data-testid="work-proposal-ask"
        >
          {formatWhole(row.askWhole)} Shares
          {supplyWhole === null
            ? ""
            : ` (${formatBps(shareAfter(row.askWhole, supplyWhole))})`}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Suggested by {name} · {shortRelativeTime(row.createdAt)}
      </p>
      {row.body ? (
        <p className="mt-1 line-clamp-3 text-sm">{row.body}</p>
      ) : null}
      <p className="mt-1 text-sm">
        <span className="text-muted-foreground">Finished looks like: </span>
        {row.check}
      </p>
      {row.status === "approved" ? (
        <p
          className="mt-2 inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400"
          data-testid="work-proposal-approved"
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" /> Approved as a work
          area. {name} can submit work in it below.
        </p>
      ) : vote ? (
        <p
          className="mt-2 text-sm text-muted-foreground"
          data-testid="work-proposal-voting"
        >
          Being voted on
          {onSeeVote ? (
            <>
              {" · "}
              <button
                className="underline"
                data-testid="work-proposal-see-vote"
                onClick={() => onSeeVote(vote)}
                type="button"
              >
                See the vote
              </button>
            </>
          ) : null}
        </p>
      ) : onSponsor ? (
        <Button
          className="mt-2"
          data-testid="work-proposal-sponsor"
          onClick={() =>
            onSponsor({
              proposalId: row.id,
              proposer: row.author,
              name: row.name,
              shares: row.askWhole.toString(),
              check: row.check,
            })
          }
          size="sm"
          type="button"
          variant="outline"
        >
          Put to a vote
        </Button>
      ) : null}
    </li>
  );
}

export function SuggestedWork({
  chainId,
  dao,
  totalShares,
  approved,
  onSponsor,
  power,
  voteFor,
  onSeeVote,
}: {
  /** Who may open a vote, from the decisions read; undefined while it is read. */
  power?: ProposalPower;
  /** The open vote that would approve a suggestion, or null. */
  voteFor?: (row: ProposalRow) => string | null;
  onSeeVote?: (decisionId: string) => void;
  chainId: string | null;
  dao: string;
  /** All Shares in existence now (18 decimals); null when unknown. */
  totalShares: bigint | null;
  /** The projects the DAO approved, so an approved suggestion says so. */
  approved: readonly { projectId: string; checkHash: string }[];
  onSponsor?: (intent: SponsorIntent) => void;
}) {
  const proposals = useWorkProposals(chainId, dao, approved);
  const [suggesting, setSuggesting] = useState(false);
  const supplyWhole = wholeSupply(totalShares);
  const authors = useMemo(
    () => [...new Set(proposals.rows.map((row) => row.author))],
    [proposals.rows],
  );
  const profiles = useProfiles(authors).data;

  return (
    <Card className="p-4" data-testid="suggested-work">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Lightbulb aria-hidden className="h-4 w-4" /> Suggested work
          </h3>
          <p className="text-xs text-muted-foreground">
            Suggest work and name your price. If it's voted in, it opens to
            everyone.
            {cannotOpenDecision(power)
              ? ` ${whoMayOpen(power)} can put a suggestion to a vote.`
              : ""}
          </p>
        </div>
        {suggesting ? null : (
          <Button
            data-testid="suggest-work"
            onClick={() => {
              if (existingUserPubkey() === null) {
                toast.error(needAccountTo("suggest work"));
                return;
              }
              setSuggesting(true);
            }}
            size="sm"
            type="button"
          >
            Suggest work
          </Button>
        )}
      </div>
      {suggesting ? (
        <SuggestForm
          onDone={() => setSuggesting(false)}
          onSuggest={proposals.suggest}
          supplyWhole={supplyWhole}
        />
      ) : null}
      {proposals.error ? (
        <p
          className="mt-3 text-sm text-amber-700 dark:text-amber-300"
          data-testid="suggested-work-error"
          role="status"
        >
          Suggestions could not be read just now.{" "}
          <button
            className="underline"
            onClick={proposals.refetch}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : proposals.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          Reading suggestions…
        </p>
      ) : proposals.rows.length === 0 ? (
        <p
          className="mt-3 text-sm text-muted-foreground"
          data-testid="suggested-work-empty"
        >
          No suggestions yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {proposals.rows.map((row) => (
            <ProposalCard
              key={row.id}
              name={resolveUserName(profiles?.[row.author], row.author)}
              // Putting a suggestion to a vote needs an account and enough Shares; nobody else is offered it.
              onSeeVote={onSeeVote}
              onSponsor={
                existingUserPubkey() && !cannotOpenDecision(power)
                  ? onSponsor
                  : undefined
              }
              row={row}
              supplyWhole={supplyWhole}
              vote={row.status === "approved" ? null : (voteFor?.(row) ?? null)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
