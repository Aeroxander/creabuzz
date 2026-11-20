// biome-ignore-all lint/style/noNonNullAssertion: each read is asserted non-null on the line before it is used
/**
 * The settled money the browser specs' record builder works out (`tests/e2e/helpers/live-settled.ts`) against what the Treasury
 * itself stores after a settle, at seven times: inside an arriving stream where the two roundings differ, in a merged stream,
 * after it ended, with a task taken and not due, and at the settle that puts the money of a task that ran out back. A mistake in
 * the builder shows here and not in a page. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { expect, it } from "vitest";
import { encodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { TREASURY_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { shareFor } from "../../src/features/tasks/chain/door";
import { readStored, rollForward } from "../e2e/helpers/live-settled";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, chainTime, passTime, rpc } from "./rpc";

import {
  CHAIN,
  DOLLAR,
  back,
  idHex,
  launch,
  read,
  run,
  send,
} from "./pot-tasks-scene";

run("the settled money of the record builder", () => {
  it("the settled money the browser specs' record builder works out is what the Treasury stores after a settle, at seven times", async () => {
    const [admin, founder, backer, worker, other] = await accounts();
    const chain = await deployPot(admin);
    for (const who of [founder, backer, worker, other])
      await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    const P = await launch(chain, founder, "Settled");
    await back(chain, P, backer, 200n);
    await back(chain, P, other, 100n);
    const T = P.treasury;
    const settle = {
      to: T,
      data: encodeCall(TREASURY_ABI, "settle", []),
    } as pot.PotCall;
    const money = async () => ({
      pot: reads.asBigint(
        (await reads.ask(read, TREASURY_ABI, T, "pot", []))[0],
      ),
      box: reads.asBigint(
        (await reads.ask(read, TREASURY_ABI, T, "box", []))[0],
      ),
      arriving: reads.asBigint(
        (await reads.ask(read, TREASURY_ABI, T, "arriving", []))[0],
      ),
      locked: reads.asBigint(
        (await reads.ask(read, TREASURY_ABI, T, "locked", []))[0],
      ),
      activeSeconds: reads.asBigint(
        (await reads.ask(read, TREASURY_ABI, T, "activeSeconds", []))[0],
      ),
    });
    /** Settle at second `t` and compare what the Treasury stored with what the builder worked out for `t` beforehand. */
    const settleAt = async (t: number, label: string) => {
      const stored = await readStored(T, BigInt(t));
      const predicted = rollForward(BigInt(t), stored);
      await rpc("evm_setNextBlockTimestamp", [t]);
      await send(other, settle);
      expect(await chainTime(), label).toBe(t);
      const after = await money();
      expect({ label, ...after }).toEqual({
        label,
        pot: predicted.pot,
        box: predicted.box,
        arriving: predicted.arriving,
        locked: predicted.locked,
        activeSeconds: predicted.activeSeconds,
      });
      return { stored, predicted, after };
    };
    const at = async (secs: number) => (await chainTime()) + secs;

    await send(founder, pot.checkInCall(T, `0x${"6a".repeat(32)}`));
    // Outside money starts arriving; two settles inside the stream (the second is where a rounding that follows the last settle
    // and one that follows the stream's start part), a second payment that merges into the stream, and a settle after it all.
    await walletOf(other).sendCalls(
      pot.addRevenueCalls({
        dollar: chain.dollar,
        treasury: T,
        amount: 20n * DOLLAR,
      }),
      CHAIN,
    );
    // Two times inside the stream where a formula that follows the last settle and the contract's, which follows the stream's own
    // start, give different roundings (so a builder with the wrong one is told apart): found from the stream the Treasury holds.
    const total = reads.asBigint(
      (await reads.ask(read, TREASURY_ABI, T, "arrivalTotal", []))[0],
    );
    const span = BigInt(chain.unit);
    let times: [number, number] | null = null;
    for (let t1 = 100; t1 < 700 && !times; t1 += 7)
      for (let t2 = t1 + 50; t2 < chain.unit - 50 && !times; t2 += 11) {
        const left = total - (total * BigInt(t1)) / span;
        const wrong = left - (left * BigInt(t2 - t1)) / (span - BigInt(t1));
        const right = total - (total * BigInt(t2)) / span;
        if (wrong !== right) times = [t1, t2];
      }
    expect(
      times,
      "a pair of times that tells the two formulas apart",
    ).not.toBeNull();
    const [t1, t2] = times as [number, number];
    const mid1 = await settleAt(
      await at(t1),
      "inside the stream, first settle",
    );
    expect(mid1.stored.arriving).toBeGreaterThan(0n);
    const mid2 = await settleAt(
      await at(t2 - t1),
      "inside the stream, second settle",
    );
    expect(mid2.predicted.arriving).toBeLessThan(mid1.predicted.arriving);
    const merged = await settleAt(await at(300), "inside the merged stream");
    expect(merged.stored.arriving).toBeGreaterThan(0n);
    await settleAt(await at(chain.unit * 2), "after the stream ended");

    // A task that is taken, and that runs out: its money comes back last, at the settle after its time is up.
    await send(founder, pot.checkInCall(T, `0x${"6b".repeat(32)}`));
    const potNow = reads.asBigint(
      (await reads.ask(read, TREASURY_ABI, T, "pot", []))[0],
    );
    const share = shareFor(2n * DOLLAR, potNow, 500)!;
    await send(
      founder,
      pot.announceTaskCall({
        treasury: T,
        what: idHex("d1".repeat(32)),
        payee: worker,
        maxDollars: 2n * DOLLAR,
        shareBps: share,
      }),
    );
    const notice = await reads.readNoticeFor(read, T, share);
    await passTime(notice.noticeSecs + 5);
    await send(founder, pot.checkInCall(T, `0x${"6c".repeat(32)}`));
    await send(
      worker,
      pot.takeTaskCall({ treasury: T, serial: 1n, minAmount: 2n * DOLLAR }),
    );
    const book = P.book;
    const running = await reads.readTask(read, book, 1n);
    expect(running?.state).toBe("taken");
    const during = await settleAt(
      (running!.takenAt as number) + 60,
      "a task is taken and not due",
    );
    expect(during.stored.dueC).toBe(0n);
    expect(during.predicted.locked).toBeGreaterThan(0n);
    const due = await settleAt(
      (running!.deadline as number) + 5,
      "the task ran out and the settle puts its money back",
    );
    expect(due.stored.dueC).toBe(running!.stayerClaim);
    expect(due.stored.dueC).toBeGreaterThan(0n);
    expect(due.after.locked).toBe(0n);
    expect((await reads.readTask(read, book, 1n))!.state).toBe("returned");
  });
});
