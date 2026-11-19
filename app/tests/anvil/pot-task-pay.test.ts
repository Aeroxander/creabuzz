// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * Paying an accepted task from the allowance box, against the real contracts: the draw the task's own call builder makes lands
 * as an `AllowanceDrawn` log the app's payment search finds by payee and amount (so a payment made by someone else, or by a
 * Pair's second signer, is linked to its task), a payment before the work was accepted, of another amount, to another wallet
 * or already on another task is not offered, and a draw through a Pair is found the same way. Run by `scripts/pot-app-loop.sh`;
 * skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { LAUNCHER_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import {
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import { readBack } from "../../src/features/pot/back-read";
import { proposalOf } from "../../src/features/pot/use-pair-waiting";
import { findPayment } from "../../src/features/tasks/pay-lookup";
import { drawForTaskCall } from "../../src/features/tasks/task-calls";
import { topicOf } from "../../../packages/creaton-core/src/launchpad/work.ts";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);

run("paying an accepted task from the box, against the real contracts", () => {
  it("finds the payment by payee and amount, after the acceptance, and not any other", async () => {
    const [admin, founder, backer, second, stranger] = await accounts();
    const chain = await deployPot(admin);
    const wallets = Object.fromEntries(
      [founder, backer, second, stranger].map((a) => [a, walletOf(a)]),
    );
    await wallets[backer].sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    const [settingsHash] = decodeReturn(
      LAUNCHER_ABI,
      "settingsHash",
      await read(chain.launcher, encodeCall(LAUNCHER_ABI, "settingsHash", [])),
      0,
    );
    const projectId = projectIdOf(`37001:${"ef".repeat(32)}:taskpay`);
    await wallets[founder].sendCalls(
      [
        pot.launchCall({
          launcher: chain.launcher,
          projectId,
          name: "Task pay",
          symbol: "TSK",
          ratePpm: 1000,
          teamPool: 10_000_000n * SHARE,
          settingsHash: settingsHash as string,
        }),
      ],
      CHAIN,
    );
    const key = chainKeyOf(founder, projectId);
    const parts = await state.readProjectParts(read, chain.launcher, key);
    const numbers = {
      contracts: {
        treasury: parts.treasury,
        shares: parts.shares,
        team: parts.team,
        vester: parts.vester,
        dollar: chain.dollar,
      },
      launcher: chain.launcher,
      key,
      unit: chain.unit,
      limits: { cliffUnits: 13 },
    } as unknown as ProjectNumbers;
    const back = await readBack(read, numbers, 1000n * DOLLAR, backer);
    if (!back.ok) throw new Error("the Back was not ok");
    await wallets[backer].sendCalls(back.plan.calls, CHAIN);

    // A day is a few minutes on this chain: a little over a day of allowance fills the box with more than two dollars.
    await passTime(500);
    await wallets[founder].sendCalls(
      [pot.checkInCall(parts.treasury, `0x${"5a".repeat(32)}`)],
      CHAIN,
    );
    expect(
      (await state.readAllowanceState(read, parts.treasury)).box,
    ).toBeGreaterThanOrEqual(2n * DOLLAR);

    const accepted = Math.floor(Date.now() / 1000) - 60;
    const sentBy = wallets[founder];
    const paid = await sentBy.sendCalls(
      [drawForTaskCall(parts.treasury, second, 1)],
      CHAIN,
    );
    expect(await reads.balanceOf(read, chain.dollar, second)).toBe(DOLLAR);

    const finder = wallets[stranger];
    const found = await findPayment(
      finder,
      parts.treasury,
      second,
      DOLLAR,
      accepted,
    );
    // The payment found is the draw's own transaction.
    expect(found?.txHash).toBe(paid.txHash.toLowerCase());
    expect(found?.at).not.toBeNull();
    // Not another amount, not another wallet, not one a task already carries, not one made before the work was accepted.
    expect(
      await findPayment(finder, parts.treasury, second, 2n * DOLLAR, accepted),
    ).toBeNull();
    expect(
      await findPayment(finder, parts.treasury, stranger, DOLLAR, accepted),
    ).toBeNull();
    expect(
      await findPayment(
        finder,
        parts.treasury,
        second,
        DOLLAR,
        accepted,
        new Set([paid.txHash.toLowerCase()]),
      ),
    ).toBeNull();
    expect(
      await findPayment(
        finder,
        parts.treasury,
        second,
        DOLLAR,
        (found?.at ?? 0) + 7 * 86_400,
      ),
    ).toBeNull();

    // A draw through a Pair: the founder offers the seat to the Pair of (founder, second), the second signer makes it, one
    // asks for the pay and the other confirms it. The payment the second signer's confirmation made is found by the same search.
    const [pairAddress] = decodeReturn(
      LAUNCHER_ABI,
      "pairAddress",
      await read(
        chain.launcher,
        encodeCall(LAUNCHER_ABI, "pairAddress", [key, founder, second]),
      ),
      3,
    ) as [string];
    await wallets[founder].sendCalls(
      [
        pot.handOverCall({
          treasury: parts.treasury,
          next: pairAddress,
          founderLeaves: false,
        }),
      ],
      CHAIN,
    );
    await wallets[second].sendCalls(
      [pot.makePairCall(chain.launcher, key, founder)],
      CHAIN,
    );
    const pair = pairAddress.toLowerCase();
    await passTime(500);
    await wallets[founder].sendCalls(
      [pot.pairCheckInCall(pair, `0x${"5b".repeat(32)}`)],
      CHAIN,
    );
    const draw = drawForTaskCall(parts.treasury, stranger, 1);
    await wallets[founder].sendCalls(
      [pot.pairProposeCall(pair, draw.to, draw.data)],
      CHAIN,
    );
    // Nothing is paid until the other signer confirms: the search finds nothing yet.
    expect(
      await findPayment(finder, parts.treasury, stranger, DOLLAR, accepted),
    ).toBeNull();
    const logs = await wallets[second].getLogs({
      address: pair,
      topics: [topicOf("Proposed(bytes32,address,address,bytes,uint256)")],
      from: 0,
      to: await wallets[second].blockNumber(),
    });
    const proposal = proposalOf(logs.at(-1)!, pair)!;
    const confirmed = await wallets[second].sendCalls(
      [
        pot.pairConfirmCall(
          pair,
          proposal.target,
          proposal.data,
          proposal.nonce,
        ),
      ],
      CHAIN,
    );
    const viaPair = await findPayment(
      finder,
      parts.treasury,
      stranger,
      DOLLAR,
      accepted,
    );
    expect(viaPair?.txHash).toBe(confirmed.txHash.toLowerCase());
    expect(await reads.balanceOf(read, chain.dollar, stranger)).toBe(DOLLAR);
  });
});
