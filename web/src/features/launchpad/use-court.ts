import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import {
  courtAddress,
  createFaucet,
  createToken,
  defaultChainPreset,
  openBounty,
  remixBonds,
} from "./chain-config";
import {
  type CourtView,
  encodeLastDrip,
  MAX_CASES,
  readCourt,
  saltFromSignature,
  voteKeyMessage,
} from "./lib/court";
import { readPostBountyCase, type PostBountyCase } from "./lib/open-bounty";
import { readBondCase } from "./lib/remix-bond";
import { walletError } from "./lib/wallet-effects";
import { decodeWord } from "./lib/work";
import { encodeAllowance, encodeBalanceOf } from "./lib/work-bounty";
import type { ConnectedWalletState } from "./use-connected-wallet";
import { endpointChain } from "./use-work";

/** Where every query about the court lives, so a step sent from one re-reads them all. */
export const COURT_QUERY = ["launchpad", "court"] as const;

interface CourtWallet {
  create: bigint;
  createAllowance: bigint;
  fee: bigint;
  feeAllowance: bigint;
  /** When this wallet can next take test CREATE (Unix seconds), or null without a faucet. */
  nextDrip: number | null;
}

export interface CourtPageData extends CourtView {
  chainId: number;
  now: number;
  createToken: string | null;
  faucet: string | null;
  wallet: CourtWallet | null;
  /** What each case about a bounty on a post is judged against, by case id. */
  about: Record<string, PostBountyCase>;
  /** What each case about a remix's bond is judged against, by case id. */
  remix: Record<
    string,
    { terms: string | null; amount: bigint; parentDao: string } | null
  >;
}

const DAY = 86_400;

/**
 * The court on this build's network, the connected wallet's stake and money, and the cases with what they are about:
 * the newest `limit`, every case the wallet was drawn in, and `include` (a case a link points at).
 */
export function useCourt(
  wallet: string | null,
  limit: number = MAX_CASES,
  include: bigint | null = null,
) {
  const chainId = defaultChainPreset().chainId;
  const court = courtAddress(chainId);
  const create = createToken(chainId);
  const faucet = createFaucet(chainId);
  const bonds = remixBonds(chainId);
  const askers = { bounty: openBounty(chainId), remix: bonds };
  const query = useQuery({
    queryKey: [...COURT_QUERY, court, wallet, limit, include?.toString()],
    enabled: court !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    // Showing older cases keeps the ones on screen while the rest are read.
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<CourtPageData> => {
      const chain = endpointChain(getRpcEndpoint());
      const at = court as string;
      const [view, now] = await Promise.all([
        readCourt(chain, at, wallet, {
          askers,
          limit,
          include: include === null ? [] : [include],
        }),
        chain.now(),
      ]);
      const about: Record<string, PostBountyCase> = {};
      const remix: CourtPageData["remix"] = {};
      await Promise.all(
        view.cases.map(async (c) => {
          if (c.about?.kind === "remix") {
            remix[c.id.toString()] = bonds
              ? await readBondCase(chain, bonds, c.about.bond).catch(() => null)
              : null;
            return;
          }
          if (c.about?.kind !== "bounty") return;
          about[c.id.toString()] = await readPostBountyCase(
            chain,
            c.arbitrable,
            c.about.bounty,
            c.about.claim,
          ).catch(() => ({
            post: "",
            words: null,
            claimant: null,
            evidence: null,
          }));
        }),
      );
      let side: CourtWallet | null = null;
      if (wallet) {
        const read = (token: string, data: string) =>
          chain.call(token, data).then(decodeWord);
        const [createBal, createAllow, fee, feeAllow, last] = await Promise.all(
          [
            read(view.stakeToken, encodeBalanceOf(wallet)),
            read(view.stakeToken, encodeAllowance(wallet, at)),
            read(view.feeToken, encodeBalanceOf(wallet)),
            read(view.feeToken, encodeAllowance(wallet, at)),
            faucet
              ? chain.call(faucet, encodeLastDrip(wallet)).then(decodeWord)
              : Promise.resolve(null),
          ],
        );
        side = {
          create: createBal,
          createAllowance: createAllow,
          fee,
          feeAllowance: feeAllow,
          nextDrip: last === null ? null : last === 0n ? 0 : Number(last) + DAY,
        };
      }
      return {
        ...view,
        chainId,
        now,
        createToken: create,
        faucet,
        wallet: side,
        about,
        remix,
      };
    },
  });
  return { chainId, court, query };
}

/** The secret that seals this wallet's vote in a case and round: from a signature over fixed words, so it comes back. */
export async function voteSalt(
  wallet: ConnectedWalletState,
  court: string,
  id: bigint,
  round: number,
): Promise<string> {
  if (!wallet.wallet || !wallet.address) {
    throw new Error("Connect your wallet first.");
  }
  const text = voteKeyMessage(court, id, round);
  const hex = `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  try {
    const signature = (await wallet.wallet.provider.request({
      method: "personal_sign",
      params: [hex, wallet.address],
    })) as string;
    return saltFromSignature(signature);
  } catch (error) {
    throw walletError(error);
  }
}
