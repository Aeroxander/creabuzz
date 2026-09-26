import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { Input } from "@/shared/ui/input";
import { Modal } from "./Modal";
import { clearingPrice } from "../chain";
import {
  bidPlanWithDefaultHint,
  buildBidCalls,
  validateBid,
  type BidPlan,
} from "../lib/bid-tx";
import { toAtomic } from "../lib/amounts";
import { TX_HASH_RE } from "../lib/milestone-receipt";
import { createInjectedWalletSender } from "../lib/wallet-sender";
import type { LaunchRecord } from "../models";
import { kernel033ChainRpcUrl } from "@/features/identity/lib/kernel033";
import {
  createSponsoredSender,
  SponsoredSenderUnavailableError,
} from "@/features/identity/lib/sponsoredSender";
import {
  PaymasterDeniedError,
  zerodevConfigFromEnv,
} from "@/features/identity/lib/zerodev";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { OwnershipOnlyNote } from "./widgets";

interface BidInput {
  bucket: string;
  budget: string;
  maxPrice: string;
  tx: string;
  asAgent?: boolean;
}

/**
 * Investor flow: bid onchain, then mirror the tx hash into the feed.
 *
 * The dialog composes the real CCA `submitBid` calldata (the exact bytes the
 * contract accepts — `lib/bid-tx.ts`, bound by `BidCalldata.t.sol`), snaps the
 * desired max price onto the auction's tick grid, and validates against the
 * same reverts. The sender is a picker: the injected wallet (current) or the
 * passkey-owned Kernel-0.3.3 account with ZeroDev gas sponsorship
 * (`lib/sponsoredSender.ts`). Both consume the SAME composed calls — the
 * sender swap never changes the calldata. After a send the hash is recorded;
 * without any sender (or an indexer/agent that bid elsewhere) the manual hash
 * entry stays available. The mirror (`Record bid`) is only
 * enabled once a tx hash exists: the chain is the ledger, the mirror is the
 * record, and a mirror with no tx would claim a bid that never landed.
 */
export function RecordBidDialog({
  isPublishing,
  launchName,
  record,
  rpcEndpoint,
  onClose,
  onPublish,
}: {
  isPublishing: boolean;
  launchName: string;
  record: LaunchRecord;
  rpcEndpoint: string;
  onClose: () => void;
  onPublish: (input: BidInput) => Promise<void>;
}) {
  const [asAgent, setAsAgent] = useState(false);
  /**
   * The action that failed, kept so a successful passkey unlock can resume it
   * (Rule 6: the recovery must lead back to the thing the reader was doing).
   */
  const resumeRef = useRef<(() => void) | null>(null);
  const [bucket, setBucket] = useState("bucket-0");
  const [budget, setBudget] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [tx, setTx] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState<bigint | null>(null);
  const [senderKind, setSenderKind] = useState<"wallet" | "passkey">("wallet");
  const [passkeyAccount, setPasskeyAccount] = useState<string | null>(null);
  const [passkeyNote, setPasskeyNote] = useState<string | null>(null);

  const auction = record.auction;
  const floorPriceQ96 = toAtomic(record.floorPrice) ?? null;
  const tickSpacingQ96 = toAtomic(record.tickSpacing) ?? null;

  // Read the clearing price once per opening. A failed read is honest: the
  // contract still enforces "above clearing" at bid time, so the user can
  // proceed, but the dialog cannot pre-check that rule.
  useEffect(() => {
    let alive = true;
    if (!auction) {
      setClearing(null);
      return;
    }
    clearingPrice(rpcEndpoint, auction).then((p) => {
      if (alive) setClearing(p);
    });
    return () => {
      alive = false;
    };
  }, [auction, rpcEndpoint]);

  const budgetAtomic = useMemo(() => toAtomic(budget), [budget]);

  const plan: BidPlan | null = useMemo(() => {
    if (
      floorPriceQ96 === null ||
      tickSpacingQ96 === null ||
      budgetAtomic === null
    ) {
      return null;
    }
    const desired = toAtomic(maxPrice);
    if (desired === null) return null;
    // Snap up to the grid: a price between ticks reverts onchain
    // (TickPriceNotAtBoundary), and snapping up keeps the user's premium
    // rather than silently undercutting it.
    const snapped = desired - (desired % tickSpacingQ96);
    const maxPriceQ96 =
      snapped === desired ? snapped : snapped + tickSpacingQ96;
    return bidPlanWithDefaultHint(
      {
        maxPriceQ96,
        amount: budgetAtomic,
        owner: "0x0000000000000000000000000000000000000000",
        hookData: "0x",
      },
      floorPriceQ96,
    );
  }, [budgetAtomic, floorPriceQ96, maxPrice, tickSpacingQ96]);

  const issues = useMemo(() => {
    if (!plan || tickSpacingQ96 === null || floorPriceQ96 === null) return [];
    // The record does not carry the auction supply, so the ceiling check is
    // skipped (supply null); everything else the contract enforces still
    // holds. When the clearing price is unreadable, the "above clearing" rule
    // is left to the contract rather than guessed.
    return validateBid(
      { ...plan, owner: "0x0000000000000000000000000000000000000000" },
      {
        tickSpacingQ96,
        clearingPriceQ96: clearing ?? 0n,
        supply: null,
      },
    ).filter(
      (i) =>
        !(
          clearing === null &&
          i.field === "maxPrice" &&
          i.message.includes("clearing price")
        ),
    );
  }, [clearing, floorPriceQ96, plan, tickSpacingQ96]);

  const wallet = window.ethereum as
    | {
        request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      }
    | undefined;

  // The passkey sender runs on the sponsored stack's chain (Sepolia in this
  // wave): the ZeroDev chain id plus `kernel033ChainRpcUrl`'s RPC for the
  // kernel reads. Missing config is an explicit unavailable state below.
  const chainId = zerodevConfigFromEnv().chainId ?? 0;
  const sponsoredRpcUrl = useMemo(() => {
    if (!Number.isInteger(chainId) || chainId <= 0) return "";
    try {
      return kernel033ChainRpcUrl(chainId);
    } catch {
      return "";
    }
  }, [chainId]);
  const sponsoredSender = useMemo(
    () => createSponsoredSender({ chainId, rpcUrl: sponsoredRpcUrl }),
    [chainId, sponsoredRpcUrl],
  );
  const sponsoredStatus = useMemo(
    () => sponsoredSender.availability(),
    [sponsoredSender],
  );

  // Derive the counterfactual account when the passkey option is picked.
  // Fence the async result (Rule 2): a stale derivation must not write state.
  useEffect(() => {
    if (senderKind !== "passkey") return;
    let alive = true;
    setPasskeyAccount(null);
    setPasskeyNote(null);
    sponsoredSender.getAddress().then(
      (address) => {
        if (alive) setPasskeyAccount(address);
      },
      (err: unknown) => {
        if (alive) {
          setPasskeyNote(
            err instanceof Error
              ? err.message
              : "Could not derive the account.",
          );
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [senderKind, sponsoredSender]);

  let passkeyStatusText = "Deriving the account address…";
  if (!sponsoredStatus.available) {
    passkeyStatusText =
      `${sponsoredStatus.reason ?? ""} ${sponsoredStatus.action ?? ""}`.trim();
  } else if (passkeyNote) {
    passkeyStatusText = passkeyNote;
  } else if (passkeyAccount) {
    passkeyStatusText = `Account ${truncatePubkey(passkeyAccount)} — tokens and refunds settle there. Gas is sponsored on chain ${chainId}.`;
  }

  const sendBid = async () => {
    if (!auction || !plan) return;
    resumeRef.current = () => void sendBid();
    setError(null);
    setSending(true);
    try {
      const sender =
        senderKind === "passkey"
          ? sponsoredSender
          : createInjectedWalletSender(wallet);
      const senderAddress = await sender.getAddress();
      // Owner is the sending account: tokens and refunds settle there. The
      // budget is pulled from the CALLER onchain, so the composed calldata is
      // sender-agnostic apart from this owner choice.
      const ownerPlan = { ...plan, owner: senderAddress };
      const calls = buildBidCalls({
        auction,
        plan: ownerPlan,
        currency: record.currency ?? null,
        deadline: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
      });
      const result = await sender.sendCalls(calls);
      if (!TX_HASH_RE.test(result.txHash))
        throw new Error("The sender returned an invalid hash.");
      setTx(result.txHash);
    } catch (err) {
      if (err instanceof PaymasterDeniedError) {
        setError(`${err.serverMessage} ${err.dashboardAction}`);
      } else if (
        err instanceof SponsoredSenderUnavailableError &&
        err.availability.action
      ) {
        setError(`${err.message} ${err.availability.action}`);
      } else {
        setError(err instanceof Error ? err.message : "The bid was not sent.");
      }
    } finally {
      setSending(false);
    }
  };

  const submit = () => {
    if (isPublishing) return;
    if (tx.trim() !== "" && !TX_HASH_RE.test(tx.trim())) {
      setError("Transaction hash must be 0x + 64 hex characters.");
      return;
    }
    if (tx.trim() === "") {
      setError(
        "Send the bid first, or paste the hash of a bid you made elsewhere.",
      );
      return;
    }
    setError(null);
    resumeRef.current = submit;
    void onPublish({
      bucket: bucket.trim() || "bucket-0",
      budget: budget.trim(),
      maxPrice: maxPrice.trim(),
      tx: tx.trim(),
      asAgent,
    });
  };

  const canMirror = tx.trim() !== "" && !isPublishing;
  const canSend =
    auction !== null && plan !== null && issues.length === 0 && !sending;

  return (
    <Modal label={`Back ${launchName}`} onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        Back {launchName}
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Your bid is a submitBid call on the auction contract; the feed mirror
        records the transaction hash. The chain is the ledger.
      </p>
      {!auction ? (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This launch has no auction contract linked yet, so it cannot accept
          bids. You can compose the terms below but nothing will send.
        </p>
      ) : null}
      <fieldset className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
        <legend className="text-sm font-medium">Send with</legend>
        <label className="flex items-start gap-2 text-sm text-black/80 dark:text-white/80">
          <input
            checked={senderKind === "wallet"}
            data-testid="bid-sender-wallet"
            name="bid-sender"
            onChange={() => setSenderKind("wallet")}
            type="radio"
          />
          <span>
            Injected wallet (current)
            {!wallet ? (
              <span className="block text-xs text-black/60 dark:text-white/60">
                No injected wallet in this browser — pick the passkey account
                instead.
              </span>
            ) : null}
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2 text-sm text-black/80 dark:text-white/80">
          <input
            checked={senderKind === "passkey"}
            data-testid="bid-sender-passkey"
            name="bid-sender"
            onChange={() => setSenderKind("passkey")}
            type="radio"
          />
          <span>
            Passkey account — gas sponsored (Sepolia)
            {senderKind === "passkey" ? (
              <span
                className="block text-xs text-black/60 dark:text-white/60"
                data-testid="bid-sender-passkey-status"
              >
                {passkeyStatusText}
              </span>
            ) : null}
          </span>
        </label>
      </fieldset>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <label className="text-sm font-medium" htmlFor="bid-bucket">
            Bucket
          </label>
          <Input
            id="bid-bucket"
            className="mt-1"
            onChange={(e) => setBucket(e.target.value)}
            placeholder="bucket-0"
            value={bucket}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium" htmlFor="bid-budget">
              Budget (base units)
            </label>
            <Input
              id="bid-budget"
              data-testid="bid-budget"
              className="mt-1"
              onChange={(e) => setBudget(e.target.value)}
              placeholder="1000000"
              value={budget}
              type="number"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="bid-max-price">
              Max price (Q96)
            </label>
            <Input
              id="bid-max-price"
              data-testid="bid-max-price"
              className="mt-1"
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="2000000000000000000000000"
              value={maxPrice}
              type="number"
            />
          </div>
        </div>
        {clearing !== null ? (
          <p className="text-xs text-black/60 dark:text-white/60">
            Current clearing price: {clearing.toString()} Q96. Your max price
            must be above it.
          </p>
        ) : (
          <p className="text-xs text-black/60 dark:text-white/60">
            Clearing price unavailable right now; the contract still enforces
            "above clearing" when the bid lands.
          </p>
        )}
        {issues.length > 0 ? (
          <ul
            data-testid="bid-issues"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {issues.map((i) => (
              <li key={i.message}>{i.message}</li>
            ))}
          </ul>
        ) : null}
        <SignRecovery
          message={error}
          onUnlocked={() => {
            const resume = resumeRef.current;
            resume?.();
          }}
          testId="bid-sign-recovery"
        />
        <div>
          <label className="text-sm font-medium" htmlFor="bid-tx">
            Transaction hash
          </label>
          <Input
            id="bid-tx"
            data-testid="bid-tx"
            className="mt-1"
            onChange={(e) => setTx(e.target.value)}
            placeholder="0x…"
            value={tx}
          />
        </div>
      </div>
      <details
        className="mt-3 rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
        data-testid="bid-advanced"
      >
        <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
          Advanced
          <span className="ml-2 text-xs font-normal text-black/50 dark:text-white/50">
            who records this bid
          </span>
        </summary>
        <label className="mt-2 flex items-start gap-2 text-sm text-black/60 dark:text-white/60">
          <input
            checked={asAgent}
            data-testid="bid-as-agent"
            onChange={(e) => setAsAgent(e.target.checked)}
            type="checkbox"
          />
          Sign as agent instead of me
        </label>
        <p
          className="mt-1 text-xs text-black/60 dark:text-white/60"
          data-testid="bid-as-agent-explainer"
        >
          The bid record will be signed by this browser&apos;s agent key (an
          attested AI-agent identity) instead of your personal key — useful when
          an agent manages the bid&apos;s follow-up.
        </p>
      </details>
      {/* §7 "Launch page copy": said before the bid button, every time. */}
      <OwnershipOnlyNote className="mt-4" />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          data-testid="bid-send"
          disabled={!canSend}
          onClick={() => void sendBid()}
          type="button"
        >
          {sending ? "Sending…" : "Send bid"}
        </Button>
        <Button
          data-testid="bid-record"
          disabled={!canMirror}
          onClick={submit}
          type="button"
        >
          {isPublishing ? "Recording…" : "Record bid"}
        </Button>
      </div>
    </Modal>
  );
}
