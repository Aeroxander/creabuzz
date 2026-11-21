/**
 * The earlier backers' claim page (`/earlier-grant`, only in a build that was given its three settings). A person opens their own
 * link (`#<their row>`), signs in, reads what the contract will do, opens the text, ticks the box and presses once. The row,
 * its proof and the signed-in account are checked here before any press (`earlier-grant-state.ts`), and again by the contract.
 * The page never shows another person's row, never lists rows, and holds none: the list is one fingerprint.
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import { earlierClaimCall } from "@creaton/core/pot/pot-calls.ts";
import {
  earlierIsBound,
  earlierRowClaimed,
  earlierTextHash,
} from "@creaton/core/pot/pot-reads.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { BackHeader } from "../../app/BackHeader";
import { buttonClass, Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { parseNumbers, type NumbersEvent } from "../money/numbers";
import { potProblem } from "../money/pot-copy";
import {
  useMoneySend,
  useRecentNumbers,
  useSenderWords,
  useWallet,
  useWalletAddress,
} from "../money/use-money";
import { rememberSendTargets } from "../money/send-targets";
import { sharesWords } from "../pot/pot-words";
import { type Ready, WalletGate } from "../pot/use-pot";
import { potNetwork } from "../../lib/pot-network";
import {
  CLAIM_BUTTON,
  CLAIM_RECORDS,
  CONSENT_LABEL,
  permanenceSentence,
} from "./earlier-grant-consent";
import type { EarlierGrantSettings } from "./earlier-grant-settings";
import {
  type EarlierLink,
  earlierState,
  readEarlierLink,
} from "./earlier-grant-state";
import {
  ALREADY_CLAIMED,
  claimedCount,
  clockWords,
  COULD_NOT_READ,
  CLAIMED,
  fingerprintLine,
  MUST_READ_FIRST,
  NOT_FOR_YOU,
  NOT_OPEN,
  READ_THE_TEXT,
  SIGN_IN,
  TAKING_OUT,
  TEXTS_DIFFER,
  yourGrant,
} from "./earlier-grant-words";

/** The project whose record names this build's claim contract, from the server's recent records. Null while none does. */
function useClaimRecord(settings: EarlierGrantSettings) {
  const recent = useRecentNumbers(true, 3);
  const signer = serverRelaySigner();
  const found = useMemo(() => {
    for (const event of recent.data?.events ?? []) {
      const numbers = parseNumbers(event as NumbersEvent, signer);
      if (
        numbers &&
        !numbers.removed &&
        numbers.earlierGrants?.contract === settings.contract
      )
        return numbers;
    }
    return null;
  }, [recent.data, signer, settings.contract]);
  return { numbers: found, pending: recent.isPending, error: recent.isError };
}

function Claim({
  settings,
  ready,
  chainId,
}: {
  settings: EarlierGrantSettings;
  ready: Ready;
  chainId: number;
}) {
  const record = useClaimRecord(settings);
  const link: EarlierLink | null = useMemo(
    () => readEarlierLink(window.location.hash),
    [],
  );
  const [opened, setOpened] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const wallet = useWallet();
  const words = useSenderWords();
  const toast = useToast();
  const queryClient = useQueryClient();
  const tickId = useId();
  const hintId = useId();
  const send = useMoneySend(`earlier-claim:${chainId}:${settings.contract}`);
  const grants = record.numbers?.earlierGrants ?? null;
  // The claim contract is one this app has read from a record that names it: a passkey send may go to it.
  if (grants) rememberSendTargets([grants.contract]);
  const chain = useQuery({
    queryKey: [
      "earlier-grant",
      settings.contract,
      ready.address,
      link?.index.toString() ?? "none",
    ],
    enabled: Boolean(grants),
    staleTime: 10_000,
    retry: false,
    queryFn: async () => ({
      textHash: await earlierTextHash(ready.read, settings.contract),
      bound: await earlierIsBound(ready.read, settings.contract),
      claimed: link
        ? await earlierRowClaimed(ready.read, settings.contract, link.index)
        : false,
    }),
  });

  if (record.pending || (grants && chain.isPending && !chain.isError))
    return <Card className="h-32 animate-pulse" data-testid="claim-reading" />;
  if (record.error || chain.isError)
    return (
      <div className="flex flex-col gap-2" data-testid="claim-read-failed">
        <p className="text-sm">{COULD_NOT_READ}</p>
        <Button
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ["earlier-grant"] });
            void chain.refetch();
          }}
          variant="secondary"
        >
          Try again
        </Button>
      </div>
    );
  const state = earlierState({
    account: ready.address,
    link,
    record: grants,
    buildTextHash: settings.textHash,
    chain: chain.data ?? null,
  });
  const counts = grants ? (
    <p className="text-sm text-muted" data-testid="claim-count">
      {claimedCount(grants.claimedRows, grants.rows)}
    </p>
  ) : null;
  if (done)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm" data-testid="claim-done">
          {CLAIMED}
        </p>
        {counts}
      </div>
    );
  if (state.kind === "not-open")
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm" data-testid="claim-not-open">
          {NOT_OPEN}
        </p>
        {counts}
      </div>
    );
  if (state.kind === "texts-differ")
    return (
      <div className="flex flex-col gap-3">
        <p
          className="text-sm text-danger"
          data-testid="claim-texts-differ"
          role="alert"
        >
          {TEXTS_DIFFER}
        </p>
        {counts}
      </div>
    );
  if (state.kind === "not-for-you")
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm" data-testid="claim-not-for-you">
          {NOT_FOR_YOU}
        </p>
        {counts}
      </div>
    );
  if (state.kind === "claimed")
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm" data-testid="claim-already">
          {ALREADY_CLAIMED}
        </p>
        {counts}
      </div>
    );
  if (state.kind !== "row" || !grants)
    return <Card className="h-32 animate-pulse" data-testid="claim-reading" />;

  const { row, link: mine } = state;
  const canPress = ticked && opened && !checking && !send.isPending;
  const press = async () => {
    if (!canPress) return;
    setProblem(null);
    setChecking(true);
    let shown: string | null = null;
    try {
      shown = await wallet.connectedAddress();
    } catch {
      shown = null;
    }
    setChecking(false);
    // The row was made for one account; it is never sent for another one the wallet shows now.
    if (shown !== ready.address.toLowerCase()) return setProblem(NOT_FOR_YOU);
    send.send(
      {
        chainId,
        build: () => [
          {
            ...earlierClaimCall({
              contract: settings.contract,
              index: mine.index,
              amount: mine.amount,
              proof: mine.proof,
              accepted: settings.textHash,
            }),
          },
        ],
        detail: mine.index.toString(),
        // A call replaced in the wallet may have landed under another hash: the row being claimed now says so.
        confirm: async (w) =>
          earlierRowClaimed(
            (to, data) => w.readCall(to, data),
            settings.contract,
            mine.index,
          ),
      },
      {
        onSuccess: () => {
          setDone(true);
          toast(CLAIMED, "done");
          void queryClient.invalidateQueries({ queryKey: ["earlier-grant"] });
          void queryClient.invalidateQueries({ queryKey: ["pot"] });
        },
        onError: (error) => setProblem(potProblem(error, "earlier-claim")),
      },
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="claim-row">
      <div className="flex flex-col gap-2">
        <p className="font-semibold" data-testid="claim-grant">
          {yourGrant(row.amount)}
        </p>
        <p className="text-sm" data-testid="claim-vesting">
          {permanenceSentence(clockWords(grants.clockSecs))}
        </p>
        <p className="text-sm text-muted" data-testid="claim-taking-out">
          {TAKING_OUT}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm" data-testid="claim-fingerprint">
          {fingerprintLine(settings.textHash)}
        </p>
        <a
          className={buttonClass({ variant: "secondary" })}
          data-testid="claim-read-text"
          href={settings.textUrl}
          onAuxClick={() => setOpened(true)}
          onClick={() => setOpened(true)}
          rel="noopener noreferrer"
          target="_blank"
        >
          {READ_THE_TEXT}
        </a>
        {opened ? null : (
          <p
            className="text-sm text-muted"
            data-testid="claim-must-read"
            id={hintId}
          >
            {MUST_READ_FIRST}
          </p>
        )}
      </div>
      <label
        className="flex min-h-11 cursor-pointer items-start gap-3 text-sm"
        htmlFor={tickId}
      >
        <input
          checked={ticked}
          className="mt-0.5 size-5 shrink-0 accent-current"
          data-testid="claim-tick"
          id={tickId}
          onChange={(e) => setTicked(e.target.checked)}
          type="checkbox"
        />
        {CONSENT_LABEL}
      </label>
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid="claim-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Button
          aria-describedby={opened ? undefined : hintId}
          block
          data-testid="claim-press"
          disabled={!canPress}
          onClick={() => void press()}
        >
          {checking || send.isPending ? words.waiting : CLAIM_BUTTON}
        </Button>
        <p className="text-sm text-muted">{CLAIM_RECORDS}</p>
      </div>
      {counts}
      <p className="text-sm text-muted">
        {sharesWords(row.amount)} Team Shares are named in your link.
      </p>
    </div>
  );
}

export function EarlierGrantPage({
  settings,
}: {
  settings: EarlierGrantSettings;
}) {
  const network = potNetwork();
  const account = useWalletAddress().data ?? null;
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-4"
      data-testid="earlier-grant-page"
    >
      <BackHeader title="Your earlier grant" />
      {account ? null : (
        <p className="text-sm" data-testid="claim-sign-in">
          {SIGN_IN}
        </p>
      )}
      {network ? (
        <WalletGate chainId={network.chainId} what="see your grant">
          {(ready) => (
            <Claim
              chainId={network.chainId}
              ready={ready}
              settings={settings}
            />
          )}
        </WalletGate>
      ) : (
        <p className="text-sm" data-testid="claim-no-network">
          This build is not set up for a network, so nothing can be claimed
          here.
        </p>
      )}
    </main>
  );
}
