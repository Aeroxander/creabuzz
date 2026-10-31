/**
 * "Weekly rounds" (D131): the decision that names this build's rounds contract as the exchange for the project's Shares,
 * or turns off whatever exchange is named. The form reads where things stand and offers the one step that fits.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getRpcEndpoint } from "../chain";
import { weeklyRounds } from "../chain-config";
import {
  allowRoundsDecision,
  exitExchangeState,
  readExchangeIfAny,
  stopExchangeDecision,
} from "../lib/exit-exchange";
import { roundsStateLine } from "../lib/rounds-copy";
import { endpointChain } from "../use-work";
import {
  attempt,
  type DraftResult,
  DraftPanel,
  type FormProps,
} from "./decision-forms";

export function RoundsDecisionForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  const contract = weeklyRounds(ctx.chainId ?? null);
  const sharesToken = ctx.sharesToken;
  const read = useQuery({
    queryKey: ["launchpad", "weekly-rounds", "state", sharesToken],
    enabled: Boolean(sharesToken),
    queryFn: () =>
      readExchangeIfAny(endpointChain(getRpcEndpoint()), sharesToken),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const state = read.data
    ? exitExchangeState(read.data, contract, ctx.chainTime)
    : null;

  const result = useMemo<DraftResult>(() => {
    if (!state) return { problem: "Where rounds stand has not been read yet." };
    if (state.phase === "unlocked") {
      return {
        problem:
          "Shares already move freely between wallets, so there is nothing to start.",
      };
    }
    // Off: name the rounds. Another contract named or waiting: turn it off first, at once; rounds can follow.
    if (state.phase === "off") {
      return attempt(() =>
        allowRoundsDecision({ sharesToken, exchange: contract ?? "" }),
      );
    }
    return attempt(() => stopExchangeDecision({ sharesToken }));
  }, [state, sharesToken, contract]);

  if (read.isPending) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" role="status">
        Reading where rounds stand from the project&apos;s Shares…
      </p>
    );
  }
  if (read.isError) {
    return (
      <p className="mt-3 text-sm" data-testid="rounds-unreadable" role="status">
        Couldn&apos;t read the Shares from the network. Try again in a moment.
      </p>
    );
  }
  if (read.data === null) {
    return (
      <p className="mt-3 text-sm" data-testid="rounds-predates">
        This project&apos;s Shares were made before weekly rounds, so this app
        does not offer them here.
      </p>
    );
  }
  const line = state ? roundsStateLine(state.phase, state.opensAt) : null;
  return (
    <div className="mt-3 grid gap-3" data-testid="form-rounds">
      {line ? (
        <p className="text-sm" data-testid="rounds-form-state">
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
