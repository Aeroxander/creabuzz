import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Receipt } from "lucide-react";
import { type ReactNode, useState } from "react";
import { read } from "../../lib/relay";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import {
  latestProjects,
  type Project,
  projectRef,
} from "../project/project-record";
import { claimHeldCall, refundCall } from "./calls-v1";
import { OwnershipLine } from "./OwnershipLine";
import { moneyProblem } from "./money-copy";
import {
  dayText,
  dollarsText,
  holdingsFor,
  type ProjectNumbers,
  parseNumbers,
  type ReceiptNumbers,
  type RefundNow,
  receiptsFor,
  refundFor,
  sharesText,
  timeText,
} from "./numbers-v1";
import {
  chainKeyOfProject,
  useConnectWallet,
  useMoneySend,
  useWallet,
  useWalletAddress,
} from "./use-money";
import { useRecentNumbers } from "./use-money-v1";

/** Projects to name receipts by: the newest records, matched to a launch only when the record names it. */
function useLaunchedProjects(enabled: boolean) {
  return useQuery({
    queryKey: ["money", "launched-projects"],
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      latestProjects(await read({ kinds: [KIND_LAUNCH_RECORD], limit: 200 })),
  });
}

/** You reads up to 5 pages of 100 records of numbers, newest first, so a quiet project's receipts still show. */
const RECEIPT_PAGES = 5;

interface Backed {
  numbers: ProjectNumbers;
  project: Project | null;
  receipts: ReceiptNumbers[];
  held: bigint;
  free: bigint;
  /** False when this wallet is missing from a cut holders list: then its Shares are not known from the list. */
  listed: boolean;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section
      aria-labelledby="receipts-title"
      className="flex flex-col gap-3"
      data-testid="receipts"
    >
      <h2
        className="text-sm font-semibold uppercase tracking-wider text-muted"
        id="receipts-title"
      >
        Backing receipts
      </h2>
      {children}
    </section>
  );
}

/**
 * You: what you backed, what you can still take back, and your Shares held and free, from the server's reading of the
 * chain. A receipt is a receipt: the refund belongs to it, never to a Share.
 */
export function Receipts() {
  const wallet = useWallet();
  const address = useWalletAddress();
  const connect = useConnectWallet();
  const [problem, setProblem] = useState<string | null>(null);
  const me = address.data ?? null;
  const recent = useRecentNumbers(me !== null, RECEIPT_PAGES);
  const projects = useLaunchedProjects(me !== null);

  if (!wallet.isAvailable())
    return (
      <Shell>
        <Card
          className="flex items-start gap-3"
          data-testid="receipts-no-wallet"
        >
          <Receipt
            aria-hidden="true"
            className="mt-0.5 text-mint-ink"
            size={20}
          />
          <p className="text-sm text-muted">
            Open this page in a browser with your wallet to see what you backed
            and to take money back.
          </p>
        </Card>
      </Shell>
    );
  if (address.isPending) return <Card className="h-20 animate-pulse" />;
  if (!me)
    return (
      <Shell>
        <Card className="flex flex-col gap-3" data-testid="receipts-connect">
          <p className="text-sm text-muted">
            Connect the wallet you backed with to see your receipts here.
          </p>
          {problem ? (
            <p className="text-sm text-danger" role="alert">
              {problem}
            </p>
          ) : null}
          <Button
            disabled={connect.isPending}
            onClick={() =>
              connect.mutate(undefined, {
                onError: (error) => setProblem(moneyProblem(error, "connect")),
              })
            }
            size="sm"
            variant="secondary"
          >
            Connect your wallet
          </Button>
        </Card>
      </Shell>
    );
  if (recent.isPending || projects.isPending)
    return (
      <Shell>
        <Card className="h-24 animate-pulse" />
      </Shell>
    );
  if (recent.isError)
    return (
      <Shell>
        <Card className="flex flex-col gap-3">
          <p className="text-sm">Your receipts could not be read just now.</p>
          <Button
            onClick={() => void recent.refetch()}
            size="sm"
            variant="secondary"
          >
            Try again
          </Button>
        </Card>
      </Shell>
    );

  const signer = serverRelaySigner();
  // Every project record naming each chain key: a copy naming someone else's key must not hide the real project.
  const byKey = new Map<string, Project[]>();
  for (const project of projects.data ?? []) {
    const key = chainKeyOfProject(project);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), project]);
  }
  const backed: Backed[] = [];
  let cut = recent.data?.complete === false;
  for (const event of recent.data?.events ?? []) {
    const numbers = parseNumbers(event, signer);
    if (!numbers || numbers.removed) continue;
    cut ||= numbers.truncated;
    const receipts = receiptsFor(numbers, [me]);
    const { held, free, listed } = holdingsFor(numbers, [me]);
    if (receipts.length === 0 && held === 0n && free === 0n) continue;
    // A record names a launch only when that launch was made for it.
    const project =
      (byKey.get(numbers.key) ?? []).find((candidate) =>
        parseNumbers(event, signer, {
          coordinate: candidate.coordinate,
          chainKey: numbers.key,
        }),
      ) ?? null;
    backed.push({ numbers, project, receipts, held, free, listed });
  }

  return (
    <Shell>
      {backed.length === 0 ? (
        <Card data-testid="receipts-none">
          <p className="text-sm text-muted">
            {cut
              ? "Nothing found for this wallet in the newest records. Not every record was read, so an older receipt may not show here yet."
              : "This wallet has not backed a project yet."}
          </p>
        </Card>
      ) : (
        <>
          {backed.map((item) => (
            <BackedCard item={item} key={item.numbers.key} me={me} />
          ))}
          {recent.data?.complete === false ? (
            <p className="px-1 text-xs text-muted" data-testid="receipts-cut">
              Only the newest records were read, so an older receipt may not
              show here yet.
            </p>
          ) : null}
        </>
      )}
    </Shell>
  );
}

function BackedCard({ item, me }: { item: Backed; me: string }) {
  const { numbers, project } = item;
  const name = project?.name ?? "A project on the network";
  const marketOpen =
    numbers.stage.name === "council" || numbers.stage.name === "open";
  return (
    <Card className="flex flex-col gap-3" data-testid="receipt-project">
      <h3 className="headline text-xl">
        {project ? (
          <Link
            className="hover:underline"
            params={{ ref: projectRef(project) }}
            to="/p/$ref"
          >
            {name}
          </Link>
        ) : (
          name
        )}
      </h3>
      {item.receipts.map((receipt) => (
        <ReceiptRow
          key={receipt.round}
          numbers={numbers}
          projectName={name}
          receipt={receipt}
          refund={refundFor(numbers, receipt.round, me)}
        />
      ))}
      <div className="text-sm" data-testid="receipt-shares">
        {item.listed || !numbers.truncated ? (
          <p>
            Your Shares:{" "}
            <span className="num font-semibold">{sharesText(item.held)}</span>{" "}
            held for you,{" "}
            <span className="num font-semibold">{sharesText(item.free)}</span>{" "}
            free.
          </p>
        ) : (
          <p>
            Your Shares: the list of holders was cut before this wallet. Your
            receipts above set aside{" "}
            <span className="num font-semibold">
              {sharesText(
                item.receipts.reduce((sum, r) => sum + r.sharesHeld, 0n),
              )}
            </span>{" "}
            Shares for you.
          </p>
        )}
        <p className="mt-1 text-xs text-muted">
          Held Shares are released over 365 days once a market opens. Taking
          released Shares out of the hold ends the refund for them.
        </p>
      </div>
      {marketOpen && numbers.contracts.vester
        ? item.receipts
            .filter((r) => r.sharesHeld > 0n)
            .map((r) => (
              <TakeOut
                key={`out-${r.round}`}
                me={me}
                numbers={numbers}
                receipt={r}
                refund={refundFor(numbers, r.round, me)}
                vester={numbers.contracts.vester as string}
              />
            ))
        : null}
      <OwnershipLine className="text-xs text-muted" />
    </Card>
  );
}

function ReceiptRow({
  receipt,
  refund,
  numbers,
  projectName,
}: {
  receipt: ReceiptNumbers;
  refund: RefundNow | null;
  numbers: ProjectNumbers;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const canTakeBack =
    receipt.refunded === null && refund !== null && refund.refundable > 0n;
  return (
    <div
      className="flex flex-col gap-2 border-t border-white/12 pt-3"
      data-testid="receipt"
    >
      <p>
        Paid{" "}
        <span className="num font-semibold">
          {dollarsText(receipt.accepted)}
        </span>{" "}
        dollars in round {receipt.round}.
      </p>
      {receipt.refunded !== null ? (
        <p className="text-sm text-muted" data-testid="receipt-refunded">
          {receipt.refundedPaid !== null
            ? `Took back ${dollarsText(receipt.refundedPaid)} dollars on ${dayText(receipt.refunded)}.`
            : `Taken back on ${dayText(receipt.refunded)}.`}
        </p>
      ) : refund ? (
        <p className="text-sm text-muted" data-testid="receipt-refund">
          Can still take back{" "}
          <span className="num font-semibold text-ink">
            {dollarsText(refund.refundable)}
          </span>{" "}
          dollars ({refund.per100} of each 100), as of{" "}
          {timeText(numbers.asOf.time)}.
        </p>
      ) : numbers.truncated ? (
        // The record's list of refunds was cut: a missing entry says nothing about this receipt.
        <p className="text-sm text-muted" data-testid="receipt-refund-unknown">
          How much is left to take back is not in the newest numbers yet.
        </p>
      ) : (
        <p className="text-sm text-muted">Nothing left to take back.</p>
      )}
      {canTakeBack && refund ? (
        <>
          <Button
            data-testid="receipt-take-back"
            onClick={() => setOpen(true)}
            size="sm"
            variant="secondary"
          >
            Take money back
          </Button>
          <RefundSheet
            numbers={numbers}
            onOpenChange={setOpen}
            open={open}
            projectName={projectName}
            receipt={receipt}
            refund={refund}
          />
        </>
      ) : null}
    </div>
  );
}

function RefundSheet({
  open,
  onOpenChange,
  receipt,
  refund,
  numbers,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receipt: ReceiptNumbers;
  refund: RefundNow;
  numbers: ProjectNumbers;
  projectName: string;
}) {
  const rounds = numbers.contracts.rounds;
  const send = useMoneySend(
    `refund:${numbers.chainId}:${rounds ?? ""}:${receipt.round}`,
  );
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Sheet
      description="Nothing is sent until you say so here and in your wallet."
      onOpenChange={(next) => {
        if (!send.isPending) {
          setProblem(null);
          onOpenChange(next);
        }
      }}
      open={open}
      testId="refund-sheet"
      title={`Take your money back from ${projectName}?`}
    >
      <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
        <li>
          You get about {dollarsText(refund.refundable)} dollars back now: your
          unreleased money less 5 of each 100. This was worked out as of{" "}
          {timeText(numbers.asOf.time)}; the network works out the exact amount
          when you send.
        </li>
        <li>
          The Shares still held for you in round {receipt.round} are cancelled.
          This cannot be undone.
        </li>
      </ul>
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="refund-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="refund-confirm"
        disabled={send.isPending || !rounds}
        onClick={() => {
          if (!rounds) return;
          setProblem(null);
          send.send(
            {
              chainId: numbers.chainId,
              build: () => [refundCall(rounds, receipt.round)],
            },
            {
              onSuccess: () => {
                toast("Your money is on its way back to your wallet.", "done");
                onOpenChange(false);
              },
              onError: (error) => setProblem(moneyProblem(error, "refund")),
            },
          );
        }}
      >
        {send.isPending
          ? "Waiting for your wallet…"
          : send.waiting
            ? "Look for your refund"
            : `Take back ${dollarsText(refund.refundable)} dollars`}
      </Button>
    </Sheet>
  );
}

/**
 * Taking released Shares out of the hold ends the refund for them for good, so it is reviewed on a sheet first, like
 * Take money back: one press to open it, one to send.
 */
function TakeOut({
  numbers,
  vester,
  receipt,
  refund,
  me,
}: {
  numbers: ProjectNumbers;
  vester: string;
  receipt: ReceiptNumbers;
  refund: RefundNow | null;
  me: string;
}) {
  const round = receipt.round;
  const send = useMoneySend(
    `take-out:${numbers.chainId}:${vester}:${round}:${me}`,
  );
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <Button
        data-testid="receipt-take-out"
        onClick={() => setOpen(true)}
        size="sm"
        variant="secondary"
      >
        Take out released Shares of round {round}
      </Button>
      <Sheet
        description="Nothing is sent until you say so here and in your wallet."
        onOpenChange={(next) => {
          if (!send.isPending) {
            setProblem(null);
            setOpen(next);
          }
        }}
        open={open}
        testId="take-out-sheet"
        title={`Take out your released Shares of round ${round}?`}
      >
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>
            The Shares released to you so far, of the{" "}
            {sharesText(receipt.sharesHeld)} held for you in round {round}, come
            out of the hold into your wallet.
          </li>
          <li>
            {refund
              ? `The refund for them ends for good. Right now you could take back about ${dollarsText(refund.refundable)} dollars in this round (as of ${timeText(numbers.asOf.time)}); after this, less.`
              : "The refund for them ends for good. This cannot be undone."}
          </li>
        </ul>
        {problem ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
            data-testid="take-out-problem"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        <Button
          block
          data-testid="take-out-confirm"
          disabled={send.isPending}
          onClick={() => {
            setProblem(null);
            send.send(
              {
                chainId: numbers.chainId,
                build: () => [claimHeldCall(vester, round, me)],
              },
              {
                onSuccess: () => {
                  toast("Your released Shares are in your wallet.", "done");
                  setOpen(false);
                },
                onError: (error) => setProblem(moneyProblem(error, "take-out")),
              },
            );
          }}
        >
          {send.isPending
            ? "Waiting for your wallet…"
            : send.waiting
              ? "Look for your Shares"
              : "Take them out and end their refund"}
        </Button>
      </Sheet>
    </>
  );
}
