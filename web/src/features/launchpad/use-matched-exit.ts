import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";
import { KIND_EXIT_OFFER } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { getRpcEndpoint } from "./chain";
import {
  defaultChainPreset,
  localUsdcAddress,
  matchedExit,
} from "./chain-config";
import { walletError } from "./lib/wallet-effects";
import {
  distinctOffers,
  encodeIsOpen,
  type ExitOffer,
  type ExitOfferTerms,
  exitOfferTemplate,
  exitOfferTypedData,
  exitSalesState,
  exitTopic,
  MAX_EXIT_OFFERS,
  type OfferStatus,
  parseExitOffer,
  readExitSales,
  readMinNonce,
  readOfferStatus,
} from "./lib/matched-exit";
import {
  exitDenominator,
  fetchRagequitPosition,
} from "./lib/ragequit-position";
import { decodeBool, decodeWord } from "./lib/work";
import { encodeAllowance, encodeBalanceOf } from "./lib/work-bounty";
import type { ConnectedWalletState } from "./use-connected-wallet";
import { endpointChain } from "./use-work";

/** Where every query about sales between members lives, so a step sent from one re-reads them all. */
export const MATCHED_EXIT_QUERY = ["launchpad", "matched-exit"] as const;

const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;

export interface ShownOffer {
  offer: ExitOffer;
  status: OfferStatus;
}

/** The connected wallet's side: what it can sell and what it can pay. */
export interface ExitWallet {
  /** Shares it holds, less what a lock still holds back. */
  free: bigint;
  sharesAllowance: bigint;
  usdcBalance: bigint;
  usdcAllowance: bigint;
  minNonce: bigint;
}

/**
 * Sales between members for one DAO (N5), when this build names an exchange on its network: where they stand, what
 * leaving pays per Share, the open offers (checked on the chain, each once), and the connected wallet's side.
 */
export function useMatchedExit(dao: string, wallet: string | null) {
  const chainId = defaultChainPreset().chainId;
  const exchange = matchedExit(chainId);
  const usdc = usdcAddress(chainId, localUsdcAddress());
  const query = useQuery({
    queryKey: [...MATCHED_EXIT_QUERY, dao, wallet, exchange],
    enabled: exchange !== null && usdc !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const endpoint = getRpcEndpoint();
      const chain = endpointChain(endpoint);
      const exchangeAddress = exchange as string;
      const currency = usdc as string;
      const [position, now] = await Promise.all([
        fetchRagequitPosition(endpoint, dao, wallet ?? ZERO, [currency]),
        chain.now(),
      ]);
      const shares = position.sharesToken;
      const read = await readExitSales(chain, shares);
      // Shares made before sales between members have nothing to show.
      if (!read) return null;
      const state = exitSalesState(read, exchangeAddress, now);
      const total = exitDenominator({
        ...position,
        sharesToBurn: 0n,
        lootToBurn: 0n,
        pools: [],
      });
      const pool = position.rows[0]?.pool ?? 0n;
      const leavingPerShare =
        position.exitRule === "unknown" || total === 0n
          ? null
          : (pool * WAD) / total;

      let offers: ShownOffer[] = [];
      if (state.phase === "on") {
        const events = await queryEvents(relayWsUrl(), {
          kinds: [KIND_EXIT_OFFER],
          "#t": [exitTopic(chainId, shares)],
          limit: MAX_EXIT_OFFERS,
        });
        const kept = distinctOffers(
          events.flatMap((event) => {
            const parsed = parseExitOffer(event);
            return parsed ? [parsed] : [];
          }),
          { chainId, exchange: exchangeAddress, shares },
          now,
        );
        const statuses = await Promise.all(
          kept.map((offer) => readOfferStatus(chain, offer)),
        );
        offers = kept
          .map((offer, i) => ({ offer, status: statuses[i] }))
          .filter((shown) => shown.status.open);
      }

      let side: ExitWallet | null = null;
      if (wallet) {
        const [sharesAllowance, usdcBalance, usdcAllowance, minNonce] =
          await Promise.all([
            chain.call(shares, encodeAllowance(wallet, exchangeAddress)),
            chain.call(currency, encodeBalanceOf(wallet)),
            chain.call(currency, encodeAllowance(wallet, exchangeAddress)),
            readMinNonce(chain, exchangeAddress, wallet),
          ]);
        side = {
          free: position.sharesBurnable,
          sharesAllowance: decodeWord(sharesAllowance),
          usdcBalance: decodeWord(usdcBalance),
          usdcAllowance: decodeWord(usdcAllowance),
          minNonce,
        };
      }
      return {
        chainId,
        exchange: exchangeAddress,
        usdc: currency,
        shares,
        now,
        state,
        leavingPerShare,
        offers,
        wallet: side,
      };
    },
  });
  return { chainId, exchange, query };
}

/**
 * Sign an offer with the connected wallet and publish it. The exchange checks the signature before anything is
 * published, so an offer nobody could fill never reaches the list.
 */
export function usePublishOffer() {
  const queryClient = useQueryClient();
  return useCallback(
    async (wallet: ConnectedWalletState, terms: ExitOfferTerms) => {
      if (!wallet.wallet) throw new Error("Connect your wallet first.");
      let signature: string;
      try {
        signature = (await wallet.wallet.provider.request({
          method: "eth_signTypedData_v4",
          params: [terms.seller, JSON.stringify(exitOfferTypedData(terms))],
        })) as string;
      } catch (error) {
        throw walletError(error);
      }
      const offer = { ...terms, signature };
      const accepted = decodeBool(
        await endpointChain(getRpcEndpoint()).call(
          terms.exchange,
          encodeIsOpen(offer),
        ),
      );
      if (!accepted) {
        throw new Error(
          "The exchange doesn't accept this wallet's signature, so the offer was not published.",
        );
      }
      await publishAsUser(
        exitOfferTemplate(offer),
        "The server did not take your offer. Nothing was sold; try again.",
      );
      await queryClient.invalidateQueries({
        queryKey: [...MATCHED_EXIT_QUERY],
      });
    },
    [queryClient],
  );
}
