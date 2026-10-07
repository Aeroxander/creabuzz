/**
 * The backer-directed vault, live (`contracts/src/ProposalVault.sol`).
 *
 * Reads are bounded and explicit: one `getLogs` for `ProposalOpened` (the
 * vault keeps no enumerable list), one `eth_call` per proposal for its state,
 * and two single-word reads for the caller's own position. Decoding lives in
 * `lib/proposal-vault-read.ts`; the calldata in `lib/proposal-vault-tx.ts`.
 *
 * Every failure surfaces as `error` so the panel can say "unavailable" rather
 * than render an empty vault that reads as "there is nothing to fund"
 * (Review-Proven Rule 1: never a terminal failure as an empty result).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ethBlockNumber, ethCall, ethGetLogs, getRpcEndpoint } from "./chain";
import {
  createInjectedWalletSender,
  type Eip1193ProviderLike,
} from "./lib/wallet-sender";
import {
  decodeAmount,
  decodeProposal,
  isAddress,
  parseProposalOpened,
} from "./lib/proposal-vault-read";
import {
  encodeBack,
  encodeBackingWeightAt,
  encodeClaimTokens,
  encodeEscrowedOf,
  encodeFail,
  encodeJoinPrice,
  encodePledge,
  encodePricing,
  encodeRefundPosition,
  encodeRefundVouchers,
  encodeTaxBps,
  encodeTokensAtRisk,
  encodeVerify,
  encodeVouchersOf,
} from "./lib/proposal-vault-tx";
import type { FundingProposal } from "./lib/proposal-funding";
import type { ProposalVaultActions } from "./ui/ProposalFundingPanel";

export interface VaultState {
  vouchers: string;
  atRisk: string;
  proposals: FundingProposal[];
  /** Per proposal: tokens escrowed for this backer and the weight they buy. */
  own: Record<string, { escrowed: string; weight: string }>;
  /** The vault's own settings, read back rather than assumed. */
  taxBps: number;
  pricePerToken: string;
  floorPerToken: string;
  /** How far back the log scan looked, for the "since" line in the panel. */
  scannedFromBlock: number;
}

/** Look back far enough to catch every proposal a launch has opened. */
const SCAN_BLOCKS = 200_000;

export async function fetchVaultState(
  endpoint: string,
  vault: string,
  account: string | null,
): Promise<VaultState> {
  const head = await ethBlockNumber(endpoint);
  const from = head > BigInt(SCAN_BLOCKS) ? head - BigInt(SCAN_BLOCKS) : 0n;

  const logs = await ethGetLogs(endpoint, {
    address: vault,
    topics: [parseTopic()],
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${head.toString(16)}`,
  });

  const ids = new Map<string, string>();
  for (const log of logs) {
    const opened = parseProposalOpened({
      topics: log.topics,
      data: log.data,
    });
    if (opened) ids.set(opened.proposalId, opened.checkHash);
  }

  const proposals: FundingProposal[] = [];
  for (const [proposalId, checkHash] of ids) {
    const raw = await ethCall(endpoint, vault, encodeProposalId(proposalId));
    proposals.push(decodeProposal(proposalId, raw));
    // The log's checkHash is the one written up front; the getter returns the
    // same value, and the two must agree or something rewrote a check that
    // was supposed to be immutable (plan G16).
    const decoded = proposals[proposals.length - 1];
    if (decoded.checkHash !== checkHash) {
      throw new Error(
        "this proposal's milestone check changed after it opened; refusing to show it",
      );
    }
  }

  const me = account && isAddress(account) ? account : null;
  const vouchers = me
    ? decodeAmount(await ethCall(endpoint, vault, encodeVouchersOf(me)))
    : "0";
  const atRisk = me
    ? decodeAmount(await ethCall(endpoint, vault, encodeTokensAtRisk(me)))
    : "0";

  // The vault's own settings, read back rather than assumed: a hard-coded tax
  // or price would show a backer figures the chain does not agree with.
  const taxBps = Number(
    decodeAmount(await ethCall(endpoint, vault, encodeTaxBps())),
  );
  const pricing = `0x${(await ethCall(endpoint, vault, encodePricing())).slice(-40)}`;
  const firstProposal = proposals[0]?.id ?? `0x${"0".repeat(64)}`;
  const [pricePerToken, floorPerToken] = me
    ? await readPair(endpoint, pricing, encodeJoinPrice(me, firstProposal))
    : ["0", "0"];

  const own: Record<string, { escrowed: string; weight: string }> = {};
  if (me) {
    for (const proposal of proposals) {
      const escrowed = decodeAmount(
        await ethCall(endpoint, vault, encodeEscrowedOf(proposal.id, me)),
      );
      const weight = decodeAmount(
        await ethCall(
          endpoint,
          vault,
          encodeBackingWeightAt(proposal.id, me, Number(head)),
        ),
      );
      if (escrowed !== "0" || weight !== "0") {
        own[proposal.id] = { escrowed, weight };
      }
    }
  }

  return {
    vouchers,
    atRisk,
    proposals,
    own,
    taxBps,
    pricePerToken,
    floorPerToken,
    scannedFromBlock: Number(from),
  };
}

/** Two words of return data as decimal strings: `(pricePerToken, floorPerToken)`. */
async function readPair(
  endpoint: string,
  to: string,
  data: string,
): Promise<[string, string]> {
  const raw = await ethCall(endpoint, to, data);
  return [decodeAmount(raw), decodeAmount(`0x${raw.slice(2 + 64)}`)];
}

/** `ProposalOpened(bytes32,uint256,uint256,uint64,bytes32)` — the only topic we scan. */
function parseTopic(): string {
  return "0x9cd43d4d54206b1db39be13b99e79d30c3b6a18061b91c473f095755bb76418a";
}

/** `proposals(bytes32)` — the getter's calldata. */
function encodeProposalId(proposalId: string): string {
  return `0x32ed5b12${proposalId.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function useProposalVault(vault: string | null, account: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["launchpad", "proposal-vault", vault, account],
    queryFn: () => fetchVaultState(getRpcEndpoint(), vault as string, account),
    enabled: Boolean(vault && isAddress(vault)),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const send = useMutation({
    mutationFn: async (data: string) => {
      if (!vault) throw new Error("no vault deployed for this launch");
      const sender = createInjectedWalletSender(
        (window as { ethereum?: Eip1193ProviderLike }).ethereum,
      );
      return sender.sendCalls([{ to: vault, data, value: "0x0" }]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["launchpad", "proposal-vault", vault, account],
      });
    },
  });

  /**
   * The panel's actions. Each one is one signed call against the vault; the
   * panel renders none of these until a vault exists, so nothing here can be a
   * control that cannot act.
   */
  const actions: ProposalVaultActions | null = vault
    ? {
        pledge: (amount) => void send.mutate(encodePledge(amount)),
        refundVouchers: (amount) =>
          void send.mutate(encodeRefundVouchers(amount)),
        back: (proposalId, vouchers) =>
          void send.mutate(encodeBack(proposalId, vouchers)),
        claim: (proposalId) => void send.mutate(encodeClaimTokens(proposalId)),
        refund: (proposalId) =>
          void send.mutate(encodeRefundPosition(proposalId)),
      }
    : null;

  return { ...query, actions, sending: send.isPending, sendError: send.error };
}

/** The two resolution paths: the judge's calls, not a backer's. */
export { encodeFail, encodeVerify };
