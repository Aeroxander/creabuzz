import { Link } from "@tanstack/react-router";
import { CalendarClock, Coins, Users } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";
import { Meter } from "@/shared/ui/meter";
import { MoreInfo } from "@/shared/ui/more-info";
import { formatAtomic } from "../lib/amounts";
import {
  encodeAppealPostBounty,
  encodeBackClaim,
  encodePayPostBounty,
  encodeRefundPostBounty,
  encodeStartRun,
  encodeUnback,
  encodeWithdrawClaim,
  type PostBountyView,
  type PostBounties,
  postBountyStage,
  walletCan,
} from "../lib/open-bounty";
import {
  claimShareLine,
  claimsInOrder,
  evidenceLink,
  postBountyLine,
} from "../lib/post-bounty-copy";
import { defaultChainPreset } from "../chain-config";
import { useChainSend } from "../use-chain-send";
import { POST_BOUNTY_QUERY, usePostBounties } from "../use-post-bounties";
import { useWalletLabels } from "../use-wallet-labels";
import { encodeApproveBounty } from "../lib/work-bounty";
import { FailureNote, WalletStrip } from "./auction-widgets";
import { Person } from "./Face";
import { ForecastPanel } from "./ForecastPanel";
import { MoneyForecastPanel } from "./MoneyForecastPanel";
import { postBountyQuestion, questionOf } from "../lib/forecast";
import {
  AddMoneyForm,
  OpenPostBountyForm,
  SubmitWorkForm,
} from "./PostBountyForms";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * Money behind a post (N2): put some in, submit work, back the work you want paid, and the one step each bounty needs
 * next. Shown under a post when this build names a bounty contract for its network; nothing at all otherwise.
 */
export function PostBountyCard({ post }: { post: string }) {
  const sender = useChainSend(defaultChainPreset().chainId, POST_BOUNTY_QUERY);
  const { chainId, contract, postWord, query } = usePostBounties(
    post,
    sender.wallet.address,
  );
  const data = query.data;
  const people = (data?.bounties ?? []).flatMap((b) => [
    b.record.creator,
    ...b.claims.map((c) => c.claimant),
  ]);
  const labelOf = useWalletLabels(people);
  const [opening, setOpening] = useState(false);
  if (!contract || !postWord) return null;
  const money = (units: bigint) =>
    data?.currency.decimalsKnown
      ? `${formatAtomic(units, data.currency.decimals, { maxFractionDigits: 2 })} ${data.currency.symbol}`.trim()
      : `${units.toString()} raw units`;
  // A new bounty once every bounty here is over (paid or refunding), so people add to an open one instead.
  const anyLive = (data?.bounties ?? []).some((b) => {
    const kind = postBountyStage(b.record, data?.chainTime ?? 0).kind;
    return kind !== "paid" && kind !== "refunds";
  });
  return (
    <section
      aria-labelledby="post-bounty-title"
      className="border-b border-black/10 p-4 dark:border-white/10"
      data-testid="post-bounty"
    >
      <h2
        className="flex items-center gap-1.5 text-sm font-semibold"
        id="post-bounty-title"
      >
        <Coins aria-hidden className="h-4 w-4" />
        Money behind this post
      </h2>
      {query.isError ? (
        <p className="text-xs text-muted-foreground" role="status">
          The network did not answer, so the money behind this post can't be
          shown.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground" role="status">
          Reading…
        </p>
      ) : (
        <>
          {data.bounties.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              None yet. Whoever does it is paid once most of the money agrees,
              or everyone gets theirs back.
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-4">
              {data.bounties.map((bounty) => (
                <BountyItem
                  bounty={bounty}
                  busy={sender.busy}
                  data={data}
                  gate={sender.gate}
                  key={bounty.id.toString()}
                  labelOf={labelOf}
                  money={money}
                  onSend={sender.send}
                  wallet={sender.wallet.address}
                />
              ))}
              <MoreInfo label="How the money decides">
                Whoever put in more than half the money decides alone, and
                people who put money in but back nothing count as not agreeing.
              </MoreInfo>
            </div>
          )}
          {anyLive ? null : opening ? (
            <OpenPostBountyForm
              balance={data.walletBalance}
              busy={sender.busy}
              chainId={chainId}
              chainTime={data.chainTime}
              contract={data.contract}
              currency={data.currency}
              gate={sender.gate}
              money={money}
              onCancel={() => setOpening(false)}
              onDone={() => setOpening(false)}
              onSend={sender.send}
              post={postWord}
            />
          ) : (
            <Button
              className="mt-2"
              data-testid="post-bounty-open"
              disabled={!data.currency.decimalsKnown}
              onClick={() => setOpening(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              Put money behind this
            </Button>
          )}
        </>
      )}
      <WalletStrip testIdPrefix="post-bounty" wallet={sender.wallet} />
      {sender.failure ? (
        <FailureNote message={sender.failure} testId="post-bounty-failure" />
      ) : null}
    </section>
  );
}

function BountyItem({
  bounty,
  data,
  wallet,
  gate,
  busy,
  onSend,
  labelOf,
  money,
}: {
  bounty: PostBountyView;
  data: PostBounties & { chainTime: number; chainId: number };
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSend: Send;
  labelOf: (address: string) => string;
  money: (units: bigint) => string;
}) {
  const [form, setForm] = useState<"add" | "file" | null>(null);
  const now = data.chainTime;
  const { record } = bounty;
  const stage = postBountyStage(record, now);
  const can = walletCan(record, bounty.wallet, now);
  const blocked = busy !== null || gate !== null;
  const key = bounty.id.toString();
  const send = (name: string, call: string) =>
    void onSend(`post-bounty-${name}-${key}`, data.contract, call);
  const toStart = can.start(bounty.claims);
  // The court's fee, in the bounty's own money when the court is paid in it (the usual case).
  const courtFee = data.court
    ? data.court.feeToken.toLowerCase() === data.currency.address.toLowerCase()
      ? money(data.court.fee)
      : "the court's fee"
    : "";
  /** Allow the bounty to take the court's fee, then appeal: the fee pays the jurors and is not returned. */
  const appeal = async () => {
    if (!data.court) return;
    const allowed = await onSend(
      `post-bounty-appeal-allow-${key}`,
      data.court.feeToken,
      encodeApproveBounty(data.contract, data.court.fee),
    );
    if (allowed) send("appeal", encodeAppealPostBounty(bounty.id));
  };
  const held =
    stage.kind === "paid" ? record.total : record.total - record.refunded;
  return (
    <article
      className="flex flex-col gap-1 text-sm"
      data-testid="post-bounty-item"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span
          className="text-xl font-bold tabular-nums"
          data-testid="post-bounty-held"
        >
          {money(held)}
        </span>
        <Chip icon={Users}>
          {bounty.funders === 1 ? "1 person" : `${bounty.funders} people`}
        </Chip>
        {bounty.wallet.funded > 0n ? (
          <Chip tone="success">You put in {money(bounty.wallet.funded)}</Chip>
        ) : null}
      </p>
      <div>
        <p className="text-xs font-medium text-muted-foreground">Done when</p>
        <p data-testid="post-bounty-words">
          {bounty.words ?? "The words could not be checked against the bounty."}
        </p>
      </div>
      <p
        className="flex gap-1.5 text-xs text-muted-foreground"
        data-testid="post-bounty-status"
      >
        <CalendarClock aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          {postBountyLine(stage, record, bounty.claims, {
            money,
            date,
            who: labelOf,
          })}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {stage.kind === "payable" || stage.kind === "upheld" ? (
          <Button
            data-testid="post-bounty-pay"
            disabled={blocked}
            onClick={() => send("pay", encodePayPostBounty(bounty.id))}
            size="sm"
            type="button"
          >
            Pay now
          </Button>
        ) : null}
        {toStart ? (
          <Button
            data-testid="post-bounty-start"
            disabled={blocked}
            onClick={() =>
              send("start", encodeStartRun(bounty.id, toStart.claim))
            }
            size="sm"
            type="button"
          >
            Start the wait for {labelOf(toStart.claimant)}
          </Button>
        ) : null}
        {can.refund && wallet ? (
          <Button
            data-testid="post-bounty-refund"
            disabled={blocked}
            onClick={() =>
              send("refund", encodeRefundPostBounty(bounty.id, wallet))
            }
            size="sm"
            type="button"
          >
            Take back my {money(bounty.wallet.funded)}
          </Button>
        ) : null}
        {can.fund && form !== "add" ? (
          <Button
            data-testid="post-bounty-add"
            onClick={() => setForm("add")}
            size="sm"
            type="button"
            variant="outline"
          >
            Add money
          </Button>
        ) : null}
        {can.file && form !== "file" ? (
          <Button
            data-testid="post-bounty-file"
            onClick={() => setForm("file")}
            size="sm"
            type="button"
            variant="outline"
          >
            Submit your work
          </Button>
        ) : null}
        {can.appeal && data.court ? (
          <Button
            data-testid="post-bounty-appeal"
            disabled={blocked}
            onClick={() => void appeal()}
            size="sm"
            type="button"
            variant="outline"
          >
            Appeal to the court ({courtFee})
          </Button>
        ) : null}
        {stage.kind === "appealing" && stage.dispute !== null ? (
          <Link
            className="self-center text-sm underline"
            data-testid="post-bounty-case"
            hash={`case-${stage.dispute}`}
            to="/court"
          >
            See the case
          </Link>
        ) : null}
        {can.withdrawClaim ? (
          <Button
            data-testid="post-bounty-withdraw-claim"
            disabled={blocked}
            onClick={() => send("withdraw", encodeWithdrawClaim(bounty.id))}
            size="sm"
            type="button"
            variant="outline"
          >
            Withdraw my work
          </Button>
        ) : null}
      </div>
      {can.appeal && data.court ? (
        <p className="text-xs text-muted-foreground">
          Jurors drawn by the court judge your work against the words above. The
          fee pays them and is not returned.
        </p>
      ) : null}
      {form === "add" ? (
        <AddMoneyForm
          balance={data.walletBalance}
          bountyId={bounty.id}
          busy={busy}
          contract={data.contract}
          currency={data.currency}
          deadline={record.deadline}
          refundsFrom={record.refundsFrom}
          court={Boolean(data.court)}
          gate={gate}
          money={money}
          onCancel={() => setForm(null)}
          onDone={() => setForm(null)}
          onSend={onSend}
        />
      ) : null}
      {form === "file" ? (
        <SubmitWorkForm
          bountyId={bounty.id}
          busy={busy}
          contract={data.contract}
          gate={gate}
          onCancel={() => setForm(null)}
          onDone={() => setForm(null)}
          onSend={onSend}
        />
      ) : null}
      {bounty.claims.length > 0 ? (
        <ul
          className="mt-1 flex flex-col gap-2"
          data-testid="post-bounty-claims"
        >
          {claimsInOrder(bounty.claims).map((claim) => {
            const link = evidenceLink(claim.evidence);
            const mine = bounty.wallet.backs === claim.claim;
            return (
              <li
                className="rounded-xl border border-border/60 p-3"
                data-testid="post-bounty-claim"
                key={claim.claim}
              >
                <p className="flex flex-wrap items-center gap-2">
                  <Person label={labelOf(claim.claimant)} />
                  {mine ? <Chip tone="success">You back this</Chip> : null}
                </p>
                <Meter
                  className="mt-2"
                  label={`Money backing ${labelOf(claim.claimant)}'s work`}
                  max={record.counting}
                  tone="info"
                  value={claim.backing}
                />
                <p
                  className="mt-1 text-xs text-muted-foreground"
                  data-testid="post-bounty-claim-share"
                >
                  {claimShareLine(claim, record.counting)}
                </p>
                <p className="break-words">
                  {link ? (
                    <a
                      className="underline"
                      href={link}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {claim.evidence}
                    </a>
                  ) : (
                    claim.evidence
                  )}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {can.back(claim) ? (
                    <Button
                      data-testid="post-bounty-back"
                      disabled={blocked}
                      onClick={() =>
                        send("back", encodeBackClaim(bounty.id, claim.claim))
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {bounty.wallet.backs === 0
                        ? "Back this"
                        : "Move my backing here"}
                    </Button>
                  ) : null}
                  {mine && can.unback ? (
                    <Button
                      data-testid="post-bounty-unback"
                      disabled={blocked}
                      onClick={() => send("unback", encodeUnback(bounty.id))}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Withdraw my backing
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ForecastPanel
        involved={[record.creator, ...bounty.claims.map((c) => c.claimant)]}
        now={now}
        question={questionOf({
          kind: "postbounty",
          chainId: data.chainId,
          contract: data.contract,
          id: bounty.id,
        })}
        state={postBountyQuestion(record, bounty.firstRunSince, now)}
      />
      <MoneyForecastPanel
        busy={busy}
        chainId={data.chainId}
        currency={data.currency.address}
        gate={gate}
        id={bounty.id}
        money={money}
        now={now}
        onSend={onSend}
        position={bounty.wallet}
        record={record}
        wallet={wallet}
      />
      {bounty.claimsTruncated ? (
        <p className="text-xs text-muted-foreground" role="status">
          More work was submitted than is shown here.
        </p>
      ) : null}
    </article>
  );
}
