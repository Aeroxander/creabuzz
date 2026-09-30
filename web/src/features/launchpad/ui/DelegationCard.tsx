import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { decodeU256, ethCall, getRpcEndpoint } from "../chain";
import { delegateReceiptParts } from "../lib/milestone-receipt";
import { usePublishMirror } from "../use-launches";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { encodeDelegate, encodeDelegatesView } from "../lib/vote-tx";
import {
  resolveSender,
  senderErrorMessage,
  SenderPickerControls,
  useSenderPicker,
} from "./SenderPicker";
import { HashPicker } from "./HashPicker";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
// shares() on the DAO — the votes live on its Shares token (cast sig).
const SELECTOR_SHARES = "0x03314efa";

/** The connected injected-wallet account, or null (never prompts). */
async function discoverWallet(): Promise<string | null> {
  const ethereum = (
    window as unknown as {
      ethereum?: {
        request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      };
    }
  ).ethereum;
  if (!ethereum) return null;
  try {
    const accounts = (await ethereum.request({
      method: "eth_accounts",
    })) as string[];
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
}

export interface DelegateOption {
  /** EVM address (delegate targets are addresses, not npubs). */
  value: string;
  label: string;
}

/**
 * The delegation surface (agentic-governance D3/A2): voting power follows a
 * delegate until re-delegated — REVOCABLE BY DESIGN ("back to myself" is
 * always an option; majeur's `delegates()` defaults to self). Agent seats
 * are first-class delegates when the org's equity map names their wallets.
 * Delegation is the owner's control of their own votes, so it is
 * deliberately NOT budget-gated (the S3 gate supervises agent ACTIONS).
 */
export function DelegationCard({
  dao,
  members,
  author,
  launchId,
}: {
  /** The bound DAO; null = not wired (record-only, D8). */
  dao: string | null;
  /** Known delegate candidates (the equity map's holders ∪ self). */
  members: readonly DelegateOption[];
  /** The launch record's author + id (the 47005 mirror's `a` binding). */
  author: string;
  launchId: string;
}) {
  const picker = useSenderPicker();
  const mirror = usePublishMirror();
  const [walletAccount, setWalletAccount] = useState<string | null>(null);
  const [delegatee, setDelegatee] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    discoverWallet().then((address) => {
      if (alive && address) setWalletAccount((current) => current ?? address);
    });
    return () => {
      alive = false;
    };
  }, []);

  const holder =
    picker.kind === "passkey" ? picker.passkeyAccount : walletAccount;

  // shares() -> delegates(holder): who casts this holder's votes today
  // (the Shares token; self by default).
  const current = useQuery({
    queryKey: ["delegates", getRpcEndpoint(), dao, holder],
    queryFn: async () => {
      const sharesWord = await ethCall(
        getRpcEndpoint(),
        dao as string,
        SELECTOR_SHARES,
      );
      const shares = `0x${sharesWord.slice(-40)}`;
      const word = await ethCall(
        getRpcEndpoint(),
        shares,
        encodeDelegatesView(holder as string),
      );
      return {
        shares,
        delegate: `0x${decodeU256(word).toString(16).padStart(40, "0")}`,
      };
    },
    enabled: Boolean(dao && holder),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const options: DelegateOption[] = [
    ...(holder ? [{ value: holder, label: "Back to myself (reclaim)" }] : []),
    ...members.filter(
      (m) => m.value.toLowerCase() !== (holder ?? "").toLowerCase(),
    ),
  ];

  const send = async () => {
    const shares = current.data?.shares;
    if (!shares) return;
    setError(null);
    setPending(true);
    try {
      const sender = resolveSender(picker);
      const result = await sender.sendCalls([
        { to: shares, data: encodeDelegate(delegatee), value: "0x0" },
      ]);
      if (!TX_HASH_RE.test(result.txHash)) {
        throw new Error("The sender returned an invalid hash.");
      }
      setLastTx(result.txHash);
      void current.refetch();
      // D4: the assignment is a governance action — mirror it (47005,
      // table `delegate`). A mirror failure is reported; the tx already
      // landed and is NEVER re-sent.
      try {
        await mirror.mutateAsync({
          kind: KIND_LAUNCH_RECEIPT,
          author,
          launchId,
          ...delegateReceiptParts({ delegate: delegatee, tx: result.txHash }),
        });
      } catch {
        setError(
          `Delegation landed (tx ${result.txHash.slice(0, 10)}…) but its receipt mirror failed — record it from the manage panel.`,
        );
      }
    } catch (err) {
      setError(senderErrorMessage(err, "The delegation was not sent."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="p-4" data-testid="delegation-card">
      <h2 className="text-base font-semibold">Vote delegation</h2>
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        Your votes are cast by your delegate until you re-delegate — revocable
        at any time, including back to yourself. Agent seats may hold
        delegations (their authority is grant-scoped and named in receipts).
      </p>
      {current.data ? (
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          Currently delegated to{" "}
          <span className="font-mono">
            {truncatePubkey(current.data.delegate)}
          </span>
          {lastTx ? ` · last tx ${lastTx.slice(0, 10)}…` : ""}
        </p>
      ) : null}
      {!dao ? (
        <p
          className="mt-2 text-xs text-black/60 dark:text-white/60"
          role="status"
        >
          Record-only: delegation opens when the launch is bound to a DAO.
        </p>
      ) : (
        <div className="mt-2">
          <SenderPickerControls state={picker} testIdPrefix="delegate-" />
          <div className="mt-1">
            <HashPicker
              id="delegate-target"
              label="Delegate to"
              onValueChange={setDelegatee}
              options={options}
              placeholder="0x… (delegate address)"
              testId="delegate-target"
              value={delegatee}
            />
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button
              data-testid="delegate-send"
              disabled={pending || delegatee === "" || !current.data}
              onClick={() => void send()}
              size="sm"
              type="button"
            >
              Delegate votes
            </Button>
          </div>
          {error ? (
            <p
              className="mt-1 text-xs text-red-700 dark:text-red-400"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-black/50 dark:text-white/50">
            Mirrors a 47005 `delegate` receipt (the assignment is public record;
            the votes remain yours to reclaim).
          </p>
        </div>
      )}
    </Card>
  );
}
