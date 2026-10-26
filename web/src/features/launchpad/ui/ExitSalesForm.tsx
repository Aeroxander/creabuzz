/**
 * "Sales between members" (N5): the decision that names this build's matched-exit exchange on the project's Shares, or
 * turns sales off. While the Shares are locked, the named exchange is the only way Shares move between members, and it
 * can be switched on only 30 days after the vote runs. The form reads where things stand and offers the one step that
 * fits.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getRpcEndpoint } from "../chain";
import { matchedExit } from "../chain-config";
import {
  allowExitSalesDecision,
  exitSalesState,
  readExitSales,
  stopExitSalesDecision,
} from "../lib/matched-exit";
import { salesStateLine } from "../lib/matched-exit-copy";
import { endpointChain } from "../use-work";
import {
  attempt,
  type DraftResult,
  DraftPanel,
  type FormProps,
} from "./decision-forms";

export function ExitSalesForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  const exchange = matchedExit(ctx.chainId ?? null);
  const sharesToken = ctx.sharesToken;
  const read = useQuery({
    queryKey: ["launchpad", "matched-exit", "state", sharesToken],
    enabled: Boolean(sharesToken),
    queryFn: () => readExitSales(endpointChain(getRpcEndpoint()), sharesToken),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const state = read.data
    ? exitSalesState(read.data, exchange, ctx.chainTime)
    : null;

  const result = useMemo<DraftResult>(() => {
    if (!state) return { problem: "Where sales stand has not been read yet." };
    if (state.phase === "unlocked") {
      return {
        problem:
          "Shares already move freely between wallets, so there is nothing to allow.",
      };
    }
    if (state.phase === "off") {
      return attempt(() =>
        allowExitSalesDecision({ sharesToken, exchange: exchange ?? "" }),
      );
    }
    return attempt(() => stopExitSalesDecision({ sharesToken }));
  }, [state, sharesToken, exchange]);

  if (read.isPending) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" role="status">
        Reading where sales stand from the project&apos;s Shares…
      </p>
    );
  }
  if (read.isError) {
    return (
      <p
        className="mt-3 text-sm"
        data-testid="exit-sales-unreadable"
        role="status"
      >
        Couldn&apos;t read the Shares from the network. Try again in a moment.
      </p>
    );
  }
  if (read.data === null) {
    return (
      <p className="mt-3 text-sm" data-testid="exit-sales-predates">
        This project&apos;s Shares were made before sales between members, so
        this app does not offer them here.
      </p>
    );
  }
  const line = state ? salesStateLine(state.phase, state.opensAt) : null;
  return (
    <div className="mt-3 grid gap-3" data-testid="form-exit-sales">
      {line ? (
        <p className="text-sm" data-testid="exit-sales-form-state">
          {line}
        </p>
      ) : null}
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}
