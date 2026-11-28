/**
 * A Back from a passkey account, through the app's own call builders against the real pot contracts: a person with no
 * wallet and no network coin takes their play dollars from the faucet and backs a project, each as ONE operation with ONE
 * passkey prompt, the fee paid by a paymaster. The Back is one call (`transferAndCall` on the play dollar), so one
 * signature is the whole Back. Run by `scripts/phone-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { decodeExecuteCallData } from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import { LAUNCHER_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import {
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { projectIdOf } from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { planBack } from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import {
  forgetSendTargets,
  knownSendTargets,
  rememberSendTargets,
} from "../../src/features/money/send-targets";
import { potProblem } from "../../src/features/money/problems";
import type { WalletStepError } from "../../src/features/money/wallet";
import { pass, phoneWorld } from "./phone-world";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, RPC } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;

run("the phone path on anvil: a Back from a passkey account", () => {
  it("backs a project with the app's own calls: one operation, one prompt, no coin in the account", async () => {
    const [admin, founder] = await accounts();
    const chain = await deployPot(admin);
    const [settingsHash] = decodeReturn(
      LAUNCHER_ABI,
      "settingsHash",
      await call(chain.launcher, encodeCall(LAUNCHER_ABI, "settingsHash", [])),
    );
    const projectId = projectIdOf(`37001:${"c3".repeat(32)}:phone`);
    await walletOf(founder).sendCalls(
      [
        pot.launchCall({
          launcher: chain.launcher,
          projectId,
          name: "Phone",
          symbol: "PHONE",
          ratePpm: 1000,
          teamPool: 10_000_000n * 10n ** 18n,
          settingsHash: settingsHash as string,
        }),
      ],
      31337,
    );
    const [project] = decodeReturn(
      LAUNCHER_ABI,
      "project",
      await call(
        chain.launcher,
        encodeCall(LAUNCHER_ABI, "project", [founder, projectId]),
      ),
    );
    const [, shares, team, treasury, vester] = project as string[];

    const world = await phoneWorld(admin);
    try {
      const { sender, bundler, authenticator } = world;
      forgetSendTargets();
      // What the app learns by reading the project's numbers: the contracts its sends may go to.
      rememberSendTargets([chain.dollar, shares, team, treasury, vester]);
      expect(knownSendTargets().has(chain.dollar)).toBe(true);
      const account = await sender.getAddress();
      const read = (to: string, data: string) => sender.readCall(to, data);

      // The faucet, from the passkey account: one operation, one prompt.
      const prompts0 = authenticator.calls.get;
      await sender.sendCalls([pot.faucetCall(chain.dollar)], 31337);
      expect(await reads.balanceOf(read, chain.dollar, account)).toBe(
        1000n * DOLLAR,
      );
      expect(authenticator.calls.get - prompts0).toBe(1);

      // Back 25 play dollars: the dollar can pay and call, so the whole Back is one call.
      const backPlan = await planBack(read, {
        dollar: chain.dollar,
        treasury: treasury as string,
        amount: 25n * DOLLAR,
      });
      expect(backPlan?.oneSignature).toBe(true);
      expect(backPlan?.calls).toHaveLength(1);
      const sentBefore = bundler.sent.length;
      const prompts1 = authenticator.calls.get;
      const result = await sender.sendCalls(backPlan?.calls ?? [], 31337);
      expect(result.status).toBe("confirmed");
      expect(await reads.balanceOf(read, shares as string, account)).toBe(
        backPlan?.quote.shares,
      );
      expect(await reads.balanceOf(read, chain.dollar, account)).toBe(
        975n * DOLLAR,
      );
      pass(
        "a real Back (25 play dollars, one transferAndCall) from a passkey account minted exactly the Shares the quote said",
      );

      expect(bundler.sent.length - sentBefore).toBe(1);
      expect(authenticator.calls.get - prompts1).toBe(1);
      pass(
        "a real Back is one operation and one passkey signature, with no approve step",
      );
      expect(
        decodeExecuteCallData(
          bundler.sent[bundler.sent.length - 1].op.callData,
        ),
      ).toEqual(backPlan?.calls);
      pass(
        "the signed operation's call data equals the app's own Back call, in order",
      );

      // A refusal by the real Treasury (the door is shut) lands as a revert and reads in the app's own words.
      await walletOf(founder).sendCalls(
        [pot.setDoorCall(treasury as string, false)],
        31337,
      );
      bundler.simulateCalls(false);
      let caught: unknown;
      await sender.sendCalls(backPlan?.calls ?? [], 31337).catch((e) => {
        caught = e;
      });
      expect((caught as WalletStepError).reason).toBe("reverted");
      expect(potProblem(caught, "back")).toMatch(/not taking new backers/);
      pass(
        "a refusal by the real Treasury (the door is shut) comes back as the app's own words, from the receipt's revert reason",
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
