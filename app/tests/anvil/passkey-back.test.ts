/**
 * A Back from a passkey account, through the app's own call builders against the real platform contracts: the project
 * is launched and a round opened by wallets, then a person with no wallet backs it from their passkey account, with the
 * fee paid by a paymaster. The calls are `backCalls` (let the round take the dollars, then ask), sent as one operation
 * with one passkey prompt. Run by `scripts/phone-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { decodeExecuteCallData } from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import { encodeFunctionData } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  backCalls,
  openBackingCall,
  positionCallData,
} from "../../src/features/money/calls";
import { moneyProblem } from "../../src/features/money/money-copy";
import { readQuote } from "../../src/features/money/use-money";
import type { WalletStepError } from "../../src/features/money/wallet";
import {
  forgetSendTargets,
  knownSendTargets,
  rememberSendTargets,
} from "../../src/features/money/send-targets";
import { deployPlatform, mintDollars } from "./deploy";
import { accounts, call, RPC, word } from "./rpc";
import { pass, phoneWorld } from "./phone-world";
import { DOLLAR, launched, openedRound, walletOf } from "./steps";

const run = RPC ? describe : describe.skip;

run("the phone path on anvil: a Back from a passkey account", () => {
  it("backs an open round with the app's own calls, in one operation, one prompt, with no coin in the account", async () => {
    const [admin, founder, , , , , , , stranger, stake] = await accounts();
    const platform = await deployPlatform(admin, stake);
    const p = await launched(
      platform,
      founder,
      `37001:${"c3".repeat(32)}:phone`,
    );
    const opened = await walletOf(founder).sendCalls(
      [openBackingCall(platform.launcher, p.key)],
      31337,
    );
    const round = await openedRound(opened.txHash, platform.launcher);

    const world = await phoneWorld(admin);
    try {
      const { sender, bundler, authenticator } = world;
      forgetSendTargets();
      // What the app learns by reading the project (`useProjectNumbers`) and the round's dollar token (`readQuote`).
      rememberSendTargets([p.rounds, p.shares, p.treasury, p.vester]);
      const quote = await readQuote(sender, p.rounds);
      expect(quote).toBe(platform.quote);
      expect(knownSendTargets().has(quote)).toBe(true);

      const account = await sender.getAddress();
      await mintDollars(stranger, platform.quote, account, 60n * DOLLAR);
      const amount = 25n * DOLLAR;
      const calls = backCalls({
        quote,
        rounds: p.rounds,
        round: Number(round),
        amount,
      });
      expect(calls).toHaveLength(2);

      const promptsBefore = authenticator.calls.get;
      const result = await sender.sendCalls(calls, 31337);
      expect(result.status).toBe("confirmed");

      // The round has the ask, from the passkey account.
      const position = await call(
        p.rounds,
        positionCallData(Number(round), account),
      );
      expect(BigInt(`0x${position.slice(2, 66)}`)).toBe(amount);
      expect(
        await word(
          platform.quote,
          encodeFunctionData("balanceOf(address)", ["address"], [account]),
        ),
      ).toBe(35n * DOLLAR);
      pass(
        "a real Back (approve the round, then ask 25 dollars) from a passkey account changed the round's own record of the ask",
      );

      expect(bundler.sent.length).toBe(1);
      expect(authenticator.calls.get - promptsBefore).toBe(1);
      pass(
        "a real Back is one operation and one passkey signature (the real-dollar path of two calls included)",
      );

      expect(decodeExecuteCallData(bundler.sent[0].op.callData)).toEqual(calls);
      pass(
        "the signed operation's call data equals the app's own backCalls, in order",
      );

      // A Back to a round that is not open lands as a revert of the real round, and reads in the app's own words.
      bundler.simulateCalls(false);
      const tooSmall = backCalls({
        quote,
        rounds: p.rounds,
        round: Number(round) + 40,
        amount: DOLLAR,
      });
      let caught: unknown;
      await sender.sendCalls(tooSmall, 31337).catch((e) => {
        caught = e;
      });
      expect((caught as WalletStepError).reason).toBe("reverted");
      expect(moneyProblem(caught, "back")).toBe(
        "This round is not taking asks any more, so nothing was taken.",
      );
      pass(
        "a refusal by the real round (a round that is not open) comes back as the app's own words, from the receipt's revert reason",
      );

      expect(BigInt(await balance(account))).toBe(0n);
      pass(
        "the account paid no network fee: it held no coin before or after the Back",
      );
    } finally {
      await world.close();
    }
  });
});

async function balance(address: string): Promise<string> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  return ((await res.json()) as { result: string }).result;
}
