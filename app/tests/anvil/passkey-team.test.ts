// biome-ignore-all lint/style/noNonNullAssertion: each read is asserted non-null on the line before it is used
/**
 * The founder's and the team's presses from a passkey account, on the real pot contracts: launch, check in, draw from the
 * allowance box, grant Team Shares. The passkey account is the founder and the runner; the people on the other side (backers, a
 * worker, a teammate) are plain accounts. Every press goes through the app's own call builders and gates, the sender the
 * app builds (one operation, one passkey prompt, the fee paid by a paymaster) and the app's words for a refusal. Run by
 * `scripts/phone-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { decodeExecuteCallData } from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import {
  rememberSendTargets,
  forgetSendTargets,
} from "../../src/features/money/send-targets";
import { launchCallFor } from "../../src/features/launch/launch-plan";
import { isLaunched } from "../../src/features/launch/launch-read";
import { launchTermsFor } from "../../src/features/launch/launch-terms";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import { potProblem } from "../../src/features/money/problems";
import { checkInFor } from "../../src/features/money/runner";
import { runnerSend } from "../../src/features/pot/runner-calls";
import { WalletStepError } from "../../src/features/money/wallet";
import { pass, phoneWorld } from "./phone-world";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);

/** What a refused step said, in the app's own words (an error read the way a sheet reads it). */
async function stoppedWith(
  promise: Promise<unknown>,
  action: Parameters<typeof potProblem>[1],
): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WalletStepError);
  const words = potProblem(error, action);
  expect(words).not.toMatch(/0x[0-9a-f]{8}|revert|\(\)/);
  return words;
}

run(
  "founder and team presses from a passkey account, on the real contracts",
  () => {
    it("launches, checks in, draws and grants Team Shares: one operation and one prompt each", async () => {
      const [admin, backer, worker, member] = await accounts();
      const chain = await deployPot(admin);
      const world = await phoneWorld(admin);
      try {
        const { sender, bundler, authenticator } = world;
        forgetSendTargets();
        // The contracts a build names (its Launcher and dollar); a project's own contracts are remembered once it is read.
        rememberSendTargets([chain.dollar, chain.launcher]);
        const founder = (await sender.getAddress()).toLowerCase();

        /** One press of the passkey account: exactly one operation, one prompt, and the call data is the app's own calls. */
        const press = async (calls: readonly pot.PotCall[]) => {
          const sentBefore = bundler.sent.length;
          const promptsBefore = authenticator.calls.get;
          const result = await sender.sendCalls(calls, CHAIN);
          expect(result.status).toBe("confirmed");
          expect(bundler.sent.length - sentBefore).toBe(1);
          expect(authenticator.calls.get - promptsBefore).toBe(1);
          expect(
            decodeExecuteCallData(
              bundler.sent[bundler.sent.length - 1].op.callData,
            ),
          ).toEqual(calls);
          return result;
        };

        for (const who of [backer, worker, member])
          await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);

        // ---- Launch: the launch sheet's own reader, terms and call; the account is the founder --------------------------
        const project = {
          coordinate: `37001:${"d4".repeat(32)}:phone`,
          name: "phone",
        };
        const offer = await state.readLaunchOffer(read, chain.launcher);
        const terms = launchTermsFor(offer);
        if (!terms) throw new Error("the terms were refused");
        const key = chainKeyOf(founder, projectIdOf(project.coordinate));
        expect(await isLaunched(read, chain.launcher, key)).toBe(false);
        await press([
          launchCallFor({
            launcher: chain.launcher,
            project,
            founder,
            terms,
            offer,
          }),
        ]);
        expect(await isLaunched(read, chain.launcher, key)).toBe(true);
        const parts = await state.readProjectParts(read, chain.launcher, key);
        expect(parts.founder).toBe(founder);
        const treasury = parts.treasury;
        expect(await state.readSeatState(read, treasury)).toMatchObject({
          runner: founder,
        });
        rememberSendTargets([
          parts.shares,
          parts.team,
          parts.treasury,
          parts.vester,
        ]);
        pass(
          "a passkey account launches a project in one operation and one prompt, and is its founder and runner",
        );

        // Backers fill the pot: the box then holds allowance to draw.
        const numbers = (runnerAddress: string): ProjectNumbers =>
          ({
            key,
            founder,
            launcher: chain.launcher,
            chainId: CHAIN,
            unit: chain.unit,
            windDown: null,
            limits: { cliffUnits: 13 },
            contracts: {
              treasury,
              shares: parts.shares,
              team: parts.team,
              vester: parts.vester,
              dollar: chain.dollar,
              pair: null,
            },
            runner: { address: runnerAddress, isPair: false, signers: null },
            money: { pot: 0n },
          }) as unknown as ProjectNumbers;
        const asFounder = numbers(founder);
        const { planBack } = await import(
          "../../../packages/creaton-core/src/pot/pot-plans.ts"
        );
        const plan = await planBack(read, {
          dollar: chain.dollar,
          treasury,
          amount: 500n * DOLLAR,
          to: backer,
        });
        await walletOf(backer).sendCalls(plan!.calls, CHAIN);

        // ---- Check in: the weekly check-in carries the hash; the app's own builder chooses the call -------------------
        await passTime(1200);
        const hash = `0x${"5a".repeat(32)}`;
        const checkIn = checkInFor(asFounder, founder, hash);
        expect(checkIn).not.toBeNull();
        await press([checkIn as pot.PotCall]);
        pass(
          "a passkey account checks in as the runner: one operation, one prompt",
        );

        // ---- Draw from the allowance box to a worker (not to oneself) ------------------------------------------------
        const box = (await state.readAllowanceState(read, treasury)).box;
        expect(box).toBeGreaterThanOrEqual(2n * DOLLAR);
        const workerBefore = await reads.balanceOf(read, chain.dollar, worker);
        const drawn = runnerSend(
          asFounder,
          founder,
          pot.drawCall({ treasury, to: worker, amount: DOLLAR }),
        );
        expect(drawn?.through).toBe("alone");
        await press(drawn!.calls);
        expect(await reads.balanceOf(read, chain.dollar, worker)).toBe(
          workerBefore + DOLLAR,
        );
        // A draw to a contract of the project is refused by the contract, in words.
        expect(
          await stoppedWith(
            sender.sendCalls(
              [pot.drawCall({ treasury, to: treasury, amount: DOLLAR })],
              CHAIN,
            ),
            "draw",
          ),
        ).toMatch(/another person's account/);
        pass(
          "a passkey runner draws from the allowance box to a worker, and a draw to the project's own contract is refused in the app's words",
        );

        // ---- Grant Team Shares to a teammate -------------------------------------------------------------------------
        const grant = runnerSend(
          asFounder,
          founder,
          pot.grantTeamCall({ treasury, member, amount: 1_000n * SHARE }),
        );
        await press(grant!.calls);
        // The teammate holds a live grant of exactly what was granted, with its clock started.
        const grants = await Promise.all(
          [0n, 1n, 2n].map((id) =>
            state.readGrant(read, parts.vester, id).catch(() => null),
          ),
        );
        expect(
          grants.some(
            (g) =>
              g?.member === member &&
              g.total === 1_000n * SHARE &&
              g.state === 0,
          ),
        ).toBe(true);
        // A grant of less than a Share is refused in words and nothing is granted.
        expect(
          await stoppedWith(
            sender.sendCalls(
              [pot.grantTeamCall({ treasury, member, amount: SHARE / 2n })],
              CHAIN,
            ),
            "grant",
          ),
        ).toMatch(/\S/);
        pass(
          "a passkey runner grants Team Shares to a teammate in one operation and one prompt",
        );
      } finally {
        await world.close();
      }
    });
  },
);
