import {
  cancelHolderData,
  consentData,
  deliverData,
  parseClaimFragment,
} from "@creaton/core/launchpad/earlier-claim.ts";
import { useId, useState } from "react";
import { BackHeader } from "../../app/BackHeader";
import { investingOn } from "../../lib/server";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { MoneyCall } from "../money/calls";
import { sharesText } from "../money/numbers";
import {
  useConnectWallet,
  useWallet,
  useWalletAddress,
} from "../money/use-money";
import { SendButton } from "../team/SendSheet";
import { claimView, holderOf } from "./earlier-state";
import {
  type ClaimList,
  type EarlierPlace,
  useAgreementText,
  useClaimLine,
  useClaimList,
  useEarlierPlace,
} from "./use-earlier";

const call = (to: string, data: string): MoneyCall => ({
  to: to.toLowerCase(),
  data,
  value: "0x0",
});
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ending = (address: string) => `ending ${address.slice(-4)}`;
const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
/** A signed message for an agreement made in person runs out a day after it is sent. */
const IN_PERSON_SECONDS = 86_400;

/**
 * An earlier backer's page: their own line of the list, the agreement as the contract fingerprints it, and one press to
 * agree. The line comes from the link's fragment, which never leaves the browser. Only this line is ever read; no other
 * line, holder or amount is asked for or shown.
 */
export default function EarlierPage() {
  return (
    <div className="flex flex-col gap-3 pb-6">
      <BackHeader title="Your earlier backing" />
      <EarlierBody />
    </div>
  );
}

/** The page below its header (the header needs the router; the body does not). */
export function EarlierBody() {
  const titleId = useId();
  const link = parseClaimFragment(
    typeof window === "undefined" ? "" : window.location.hash,
  );
  const wallet = useWallet();
  const me = useWalletAddress().data ?? null;
  const connect = useConnectWallet();
  const { place, loading: placeLoading, error: placeError } = useEarlierPlace();
  const list = useClaimList(place);
  const line = useClaimLine(place, link);
  const text = useAgreementText(list.data);
  return (
    <div className="flex flex-col gap-3">
      {!investingOn() ? (
        <Card data-testid="earlier-off">
          <p className="text-sm text-muted">This page is not open here.</p>
        </Card>
      ) : !link ? (
        <Card data-testid="earlier-no-link">
          <h2 className="font-semibold">This link is incomplete</h2>
          <p className="text-sm text-muted">
            Open the whole link you were sent, in one piece. Nothing was read.
          </p>
        </Card>
      ) : !wallet.isAvailable() ? (
        <Card data-testid="earlier-no-wallet">
          <h2 className="font-semibold">
            Open this in a browser with your wallet
          </h2>
          <p className="text-sm text-muted">
            Agreeing is signed by the wallet this line was made for. This
            browser has no wallet.
          </p>
        </Card>
      ) : placeLoading || (place && (list.isPending || line.isPending)) ? (
        <p className="text-sm text-muted" role="status">
          Reading the list…
        </p>
      ) : !place || placeError ? (
        <Card data-testid="earlier-no-list">
          <h2 className="font-semibold">The list could not be found</h2>
          <p className="text-sm text-muted">
            The server does not name it yet. Try again in a little while.
            Nothing changed.
          </p>
        </Card>
      ) : list.isError || line.isError || !list.data || !line.data ? (
        <Card data-testid="earlier-read-failed">
          <h2 className="font-semibold">Your line could not be read</h2>
          <p className="text-sm text-muted">
            Your wallet may be on another network. Switch it to the one this
            list is on, then try again.
          </p>
          <Button
            onClick={() => {
              void list.refetch();
              void line.refetch();
            }}
            size="sm"
            variant="secondary"
          >
            Try again
          </Button>
        </Card>
      ) : (
        <Line
          connect={() => connect.mutate()}
          connecting={connect.isPending}
          line={line.data}
          link={link}
          list={list.data}
          me={me}
          place={place}
          text={text}
          titleId={titleId}
        />
      )}
      {place ? (
        <Status counts={place.counts} total={list.data?.entryCount} />
      ) : null}
    </div>
  );
}

function Status({
  counts,
  total,
}: {
  counts: EarlierPlace["counts"];
  total: bigint | undefined;
}) {
  return (
    <Card
      className="flex flex-col gap-1"
      data-testid="earlier-status"
      role="region"
      aria-label="Where the list stands"
    >
      <h2 className="font-semibold">Where the list stands</h2>
      <p className="text-sm text-muted">
        {counts.consented.count}
        {total !== undefined ? ` of ${total}` : ""} lines agreed,{" "}
        {sharesText(counts.consented.total)} Shares.{" "}
        {sharesText(counts.delivered.total)} Shares sent so far.
        {counts.replacements.pending > 0
          ? ` ${counts.replacements.pending} waiting for a replacement wallet.`
          : ""}
        {counts.listClosed ? " The list is closed." : ""}
      </p>
    </Card>
  );
}

type View = ReturnType<typeof claimView>;

function Line({
  link,
  list,
  line,
  place,
  me,
  text,
  connect,
  connecting,
  titleId,
}: {
  link: NonNullable<ReturnType<typeof parseClaimFragment>>;
  list: ClaimList;
  line: NonNullable<ReturnType<typeof useClaimLine>["data"]>;
  place: EarlierPlace;
  me: string | null;
  text: ReturnType<typeof useAgreementText>;
  connect: () => void;
  connecting: boolean;
  titleId: string;
}) {
  // The contract checks the real time on every press; this only decides which press to offer.
  const now = Math.floor(Date.now() / 1000);
  const view: View = claimView({
    linkHolder: link.holder,
    leafMatches: line.leafMatches,
    me,
    entry: line.entry,
    due: line.due,
    closed: list.closed,
    funded: list.funded,
    now,
  });
  const amount = `${sharesText(link.amount)} Shares`;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="earlier-line"
      role="region"
    >
      <h2 className="font-semibold" id={titleId}>
        Your line: {amount}
      </h2>
      {view.kind === "not-on-list" ? (
        <p
          className="text-sm text-danger"
          data-testid="earlier-not-on-list"
          role="alert"
        >
          What this link carries does not match the list. Ask for a new link.
          Nothing was changed.
        </p>
      ) : view.kind === "closed" ? (
        <p className="text-sm text-muted" data-testid="earlier-closed">
          The list is closed, so this line can no longer be agreed to.
        </p>
      ) : view.kind === "not-funded" ? (
        <p className="text-sm text-muted" data-testid="earlier-not-funded">
          The Shares for this list are not in place yet. Try again later.
        </p>
      ) : view.kind === "wrong-wallet" ? (
        <div className="flex flex-col gap-2" data-testid="earlier-wrong-wallet">
          <p className="text-sm text-muted">
            This line was made for the wallet {ending(view.holder)}.{" "}
            {view.connected
              ? `Your wallet is ${ending(view.connected)}. Switch to the right one in your wallet.`
              : "Connect it to go on."}
          </p>
          {view.connected ? null : (
            <Button
              data-testid="earlier-connect"
              disabled={connecting}
              onClick={connect}
              size="sm"
              variant="secondary"
            >
              Connect your wallet
            </Button>
          )}
        </div>
      ) : view.kind === "agreed" ? (
        <Agreed link={link} place={place} view={view} />
      ) : (
        <Open
          holder={holderOf({ linkHolder: link.holder, entry: line.entry })}
          link={link}
          list={list}
          place={place}
          replacement={view.replacement}
          text={text}
        />
      )}
    </Card>
  );
}

function Agreed({
  link,
  place,
  view,
}: {
  link: NonNullable<ReturnType<typeof parseClaimFragment>>;
  place: EarlierPlace;
  view: Extract<View, { kind: "agreed" }>;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="earlier-agreed">
      <p className="text-sm">
        Agreed. Your Shares go to the wallet{" "}
        {view.receiver ? ending(view.receiver) : "you chose"}, as they are
        released over time. The first can be sent on {day(view.deliverFrom)}, 21
        days after you agreed.
      </p>
      <p className="text-sm text-muted" data-testid="earlier-delivery">
        Sent so far: {sharesText(view.taken)} Shares. Ready to send now:{" "}
        {sharesText(view.due)} Shares.
      </p>
      {view.canDeliver ? (
        <SendButton
          action={`earlier-deliver:${place.chainId}:${place.claim}:${link.entry}`}
          block
          build={() => [call(place.claim, deliverData(link.entry))]}
          chainId={place.chainId}
          copy="deliver"
          done="Your released Shares were sent."
          label="Send my released Shares"
          testId="earlier-deliver"
        />
      ) : null}
    </div>
  );
}

function Open({
  holder,
  link,
  list,
  place,
  replacement,
  text,
}: {
  /** The wallet that agrees: the one in the link, or the replacement once one applied. */
  holder: string;
  link: NonNullable<ReturnType<typeof parseClaimFragment>>;
  list: ClaimList;
  place: EarlierPlace;
  replacement: Extract<View, { kind: "open" }>["replacement"];
  text: ReturnType<typeof useAgreementText>;
}) {
  const [read, setRead] = useState(false);
  const [other, setOther] = useState(false);
  const [receiver, setReceiver] = useState("");
  const group = useId();
  const typedOk = ADDRESS.test(receiver.trim());
  const target = other ? receiver.trim().toLowerCase() : holder;
  const ready = text.kind === "ok" && read && (!other || typedOk);
  const problem =
    other && receiver && !typedOk
      ? "That is not a wallet address. Copy it from your wallet."
      : null;
  return (
    <div className="flex flex-col gap-3" data-testid="earlier-open">
      {replacement ? (
        <div
          className="flex flex-col gap-2 rounded-xl bg-white/8 p-3"
          data-testid="earlier-replacement"
        >
          <p className="text-sm">
            A replacement wallet was proposed for this line. It takes effect on{" "}
            {day(replacement.applyAt)} unless you agree to your line first.
          </p>
          {replacement.canVeto ? (
            <SendButton
              action={`earlier-veto:${place.chainId}:${place.claim}:${link.entry}`}
              build={() => [
                call(
                  place.claim,
                  cancelHolderData(link.entry, link.amount, link.salt),
                ),
              ]}
              chainId={place.chainId}
              copy="veto"
              done="This line stays with your wallet."
              label="Keep this line with my wallet"
              testId="earlier-veto"
              variant="secondary"
            />
          ) : (
            <p className="text-sm text-muted">
              Only agreeing to your line stops it now.
            </p>
          )}
        </div>
      ) : null}
      {text.kind === "ok" ? (
        <>
          <p className="text-sm font-semibold" data-testid="earlier-summary">
            {text.summary}
          </p>
          <textarea
            aria-label="The full agreement"
            className="h-64 w-full resize-none rounded-xl bg-white/6 p-3 text-sm"
            data-testid="earlier-text"
            readOnly
            value={text.text}
          />
        </>
      ) : (
        <p
          className="text-sm text-muted"
          data-testid={`earlier-text-${text.kind}`}
          role="status"
        >
          {text.kind === "checking"
            ? "Looking for the agreement…"
            : text.kind === "moved"
              ? "The agreement this page has does not match the one the list holds now, so it is not shown and you cannot agree here yet."
              : "The agreement is not published here yet, so you cannot agree yet. Try again later."}
        </p>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Where your Shares go</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={!other}
            name={group}
            onChange={() => setOther(false)}
            type="radio"
          />
          <span>My wallet, {ending(holder)}</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={other}
            name={group}
            onChange={() => setOther(true)}
            type="radio"
          />
          <span>Another wallet</span>
        </label>
        {other ? (
          <div className="flex flex-col gap-1">
            <label className="text-sm" htmlFor={`${group}-to`}>
              Wallet address
            </label>
            <input
              aria-invalid={problem ? true : undefined}
              autoComplete="off"
              className="rounded-xl bg-white/8 px-3 py-2 text-sm"
              data-testid="earlier-receiver"
              id={`${group}-to`}
              onChange={(e) => setReceiver(e.target.value)}
              spellCheck={false}
              value={receiver}
            />
            {problem ? (
              <p className="text-sm text-danger" role="alert">
                {problem}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input
          checked={read}
          data-testid="earlier-read"
          disabled={text.kind !== "ok"}
          onChange={(e) => setRead(e.target.checked)}
          type="checkbox"
        />
        <span>I have read all of this.</span>
      </label>
      {text.kind === "ok" ? (
        <SendButton
          action={`earlier-consent:${place.chainId}:${place.claim}:${link.entry}`}
          block
          build={() => [
            call(
              place.claim,
              consentData({
                entry: link.entry,
                holder: link.holder,
                amount: link.amount,
                salt: link.salt,
                receiver: target,
                textHash: list.textHash,
                validUntil: BigInt(
                  Math.floor(Date.now() / 1000) + IN_PERSON_SECONDS,
                ),
              }),
            ),
          ]}
          chainId={place.chainId}
          copy="consent"
          disabled={!ready}
          done="You agreed. Your Shares are sent as they are released, from 21 days on."
          label="Agree with my wallet"
          testId="earlier-agree"
        />
      ) : null}
    </div>
  );
}
