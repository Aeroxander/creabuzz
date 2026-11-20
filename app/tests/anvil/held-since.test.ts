// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * "You have held it for N weeks" on the real contracts (plan section 2.5, 7.5; test A2-streak): the app's own reader walks an
 * account's own Transfer logs on the project's Share token and says when the present holding began. A Back starts it; a second
 * Back and Shares sent in by someone else do not move it; Taking out everything resets it, and a Back after that starts it
 * again; Shares sent out to nobody-but-another-account reset it the same way; an account that never held reads null. The times are
 * the chain's own block times (the scenario moves the chain's clock), never this machine's. Run by `scripts/pot-app-loop.sh`;
 * skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  SHARE_TOKEN_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import {
  planBack,
  planTakeOut,
} from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { heldLine, readHeldSince } from "../../src/features/pot/held-since";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC, rpc } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);

async function launch(
  chain: Awaited<ReturnType<typeof deployPot>>,
  founder: string,
) {
  const [settingsHash] = decodeReturn(
    LAUNCHER_ABI,
    "settingsHash",
    await read(chain.launcher, encodeCall(LAUNCHER_ABI, "settingsHash", [])),
    0,
  );
  const projectId = projectIdOf(`37001:${"cd".repeat(32)}:held`);
  await walletOf(founder).sendCalls(
    [
      pot.launchCall({
        launcher: chain.launcher,
        projectId,
        name: "Held",
        symbol: "HELD",
        ratePpm: 1000,
        teamPool: 10_000_000n * SHARE,
        settingsHash: settingsHash as string,
      }),
    ],
    CHAIN,
  );
  const [project] = decodeReturn(
    LAUNCHER_ABI,
    "projectByKey",
    await read(
      chain.launcher,
      encodeCall(LAUNCHER_ABI, "projectByKey", [
        chainKeyOf(founder, projectId),
      ]),
    ),
    1,
  ) as [string[]];
  return {
    shares: (project[1] as string).toLowerCase(),
    treasury: (project[3] as string).toLowerCase(),
  };
}

/** The time of the block a transaction landed in. */
async function timeOf(txHash: string): Promise<number> {
  const receipt = await rpc<{ blockNumber: string }>(
    "eth_getTransactionReceipt",
    [txHash],
  );
  const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", [
    receipt.blockNumber,
    false,
  ]);
  return Number.parseInt(block.timestamp, 16);
}

run(
  "how long an account has held a project's Shares, from its own transfers on the real contracts",
  () => {
    it("starts at a Back, ignores more coming in, resets at a take-out to nothing and at a send-out of everything", async () => {
      const [admin, founder, backer, friend, stranger] = await accounts();
      const chain = await deployPot(admin);
      const project = await launch(chain, founder);
      const wallet = (who: string) => walletOf(who);
      for (const who of [backer, friend])
        await wallet(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
      const held = (who: string) =>
        readHeldSince(wallet(who), read, {
          account: who,
          shares: project.shares,
          treasury: project.treasury,
        });
      const back = async (who: string, dollars: bigint) => {
        const plan = await planBack(read, {
          dollar: chain.dollar,
          treasury: project.treasury,
          amount: dollars,
        });
        return (await wallet(who).sendCalls(plan!.calls, CHAIN)).txHash;
      };

      // The door shuts when the team stops checking in, so the founder checks in as the clock moves.
      const later = async (seconds: number) => {
        for (let left = seconds; left > 0; left -= chain.unit) {
          await passTime(Math.min(left, chain.unit));
          await wallet(founder).sendCalls(
            [pot.checkInCall(project.treasury, `0x${"5a".repeat(32)}`)],
            CHAIN,
          );
        }
      };

      // An account that never held reads null, never "0 weeks".
      expect(await held(stranger)).toBeNull();

      // A Back starts the holding: it began in that block, and under one unit the line says the day.
      const first = await back(backer, 100n * DOLLAR);
      const startedAt = await timeOf(first);
      const a = await held(backer);
      expect(a?.since).toBe(startedAt);
      expect(a?.unit).toBe(chain.unit);
      expect(heldLine(a!)).toMatch(/^You backed .+\.$/);

      // Two and a bit units later: more Shares coming in (a second Back, and Shares sent in by a friend) do not move it.
      await later(2 * chain.unit + 100);
      await back(backer, 50n * DOLLAR);
      await back(friend, 50n * DOLLAR);
      const friendShares = await reads.balanceOf(read, project.shares, friend);
      await wallet(friend).sendCalls(
        [
          {
            to: project.shares,
            data: encodeCall(SHARE_TOKEN_ABI, "transfer", [
              backer,
              friendShares / 2n,
            ]),
            value: "0x0",
          },
        ],
        CHAIN,
      );
      const b = await held(backer);
      expect(b?.since).toBe(startedAt);
      expect(heldLine(b!)).toBe("You have held it for 2 weeks.");
      // The friend backed a little later and sent half on: the holding they kept began at their own Back.
      const f = await held(friend);
      expect(f!.since).toBeGreaterThan(startedAt);

      // Taking out everything resets it: nothing is held, so nothing is said.
      const mine = await reads.balanceOf(read, project.shares, backer);
      const out = await planTakeOut(read, {
        treasury: project.treasury,
        holder: backer,
        shares: mine,
        to: backer,
      });
      await wallet(backer).sendCalls([out!.call], CHAIN);
      expect(await held(backer)).toBeNull();

      // A Back after that starts it again, from that moment, not from the first Back.
      await later(chain.unit);
      const again = await back(backer, 20n * DOLLAR);
      const second = await held(backer);
      expect(second?.since).toBe(await timeOf(again));
      expect(second!.since).toBeGreaterThan(startedAt + 2 * chain.unit);
      expect(heldLine(second!)).toMatch(/^You backed .+\.$/);

      // Sending everything on to another account also ends the holding, and the receiver's starts at that block.
      const all = await reads.balanceOf(read, project.shares, backer);
      const sent = (
        await wallet(backer).sendCalls(
          [
            {
              to: project.shares,
              data: encodeCall(SHARE_TOKEN_ABI, "transfer", [stranger, all]),
              value: "0x0",
            },
          ],
          CHAIN,
        )
      ).txHash;
      expect(await held(backer)).toBeNull();
      expect((await held(stranger))?.since).toBe(await timeOf(sent));
    });
  },
);
