import { useQuery } from "@tanstack/react-query";

import { getRpcEndpoint } from "./chain";
import {
  courtAddress,
  createFaucet,
  createToken,
  defaultChainPreset,
} from "./chain-config";
import {
  type CourtView,
  encodeLastDrip,
  readCourt,
  saltFromSignature,
  voteKeyMessage,
} from "./lib/court";
import { readPostBountyCase, type PostBountyCase } from "./lib/open-bounty";
import { walletError } from "./lib/wallet-effects";
import { decodeWord } from "./lib/work";
import { encodeAllowance, encodeBalanceOf } from "./lib/work-bounty";
import type { ConnectedWalletState } from "./use-connected-wallet";
import { endpointChain } from "./use-work";

/** Where every query about the court lives, so a step sent from one re-reads them all. */
export const COURT_QUERY = ["launchpad", "court"] as const;

export interface CourtWallet {
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
}

const DAY = 86_400;

/** The court on this build's network, the connected wallet's stake and money, and the cases with what they are about. */
export function useCourt(wallet: string | null) {
  const chainId = defaultChainPreset().chainId;
  const court = courtAddress(chainId);
  const create = createToken(chainId);
  const faucet = createFaucet(chainId);
  const query = useQuery({
    queryKey: [...COURT_QUERY, court, wallet],
    enabled: court !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<CourtPageData> => {
      const chain = endpointChain(getRpcEndpoint());
      const at = court as string;
      const [view, now] = await Promise.all([
        readCourt(chain, at, wallet),
        chain.now(),
      ]);
      const about: Record<string, PostBountyCase> = {};
      await Promise.all(
        view.cases.map(async (c) => {
          if (!c.about) return;
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
