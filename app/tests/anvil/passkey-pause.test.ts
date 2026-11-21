/**
 * The holder pause and the earlier backers' claim from a passkey account, on the real contracts: the account claims its row
 * of an invented list, parks Shares (approve and park in one operation), takes some back, parks again until the line is
 * reached, and takes out Shares that are parked in one press that is ONE operation of two calls (un-park, then leave).
 * The team's draw is refused while the pause is on, in the app's words, and works again once the take-out lowers the parked
 * share. Every press goes through the app's own call builders and plans, the sender the app builds (one operation, one
 * passkey prompt, the fee paid by a paymaster) and the app's words. Every row is invented (anvil's public accounts and an
 * address made here). Run by `scripts/phone-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { decodeExecuteCallData } from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import { keccak256Hex } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { buildEarlierTree } from "../../../packages/creaton-core/src/pot/earlier-proof.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import {
  planBack,
  planTakeOutParked,
} from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import {
  forgetSendTargets,
  rememberSendTargets,
} from "../../src/features/money/send-targets";
import { potProblem } from "../../src/features/money/pot-copy";
import { WalletStepError } from "../../src/features/money/wallet";
import { pass, phoneWorld } from "./phone-world";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime } from "./rpc";
import { RPC } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);

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
  "the holder pause and the earlier claim from a passkey account, on the real contracts",
  () => {
    it("claims a row, parks, takes back, takes out parked Shares in one operation, and the team's draw is refused only while the line stands", async () => {
      const [admin, founder, other, outsider] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender, bundler, authenticator } = world;
        const me = (await sender.getAddress()).toLowerCase();
        // An invented list of four rows: the passkey account's is the second; another account's is the first.
        const rows = [
          { index: 0n, account: other, amount: 1_000n * SHARE },
          { index: 1n, account: me, amount: 2_500n * SHARE },
          { index: 2n, account: `0x${"22".repeat(20)}`, amount: 40n * SHARE },
          { index: 3n, account: `0x${"33".repeat(20)}`, amount: 12n * SHARE },
        ];
        const tree = buildEarlierTree(rows);
        const textHash = keccak256Hex(
          Buffer.from("an invented text for the test network").toString("hex"),
        );
        const coordinate = `37001:${"d5".repeat(32)}:zero`;
        const key = chainKeyOf(founder, projectIdOf(coordinate));
        const chain = await deployPot(admin, 1680, {
          pause: true,
          earlier: {
            root: tree.root,
            textHash,
            total: rows.reduce((sum, r) => sum + r.amount, 0n),
            rows: rows.length,
            key,
          },
        });
        forgetSendTargets();
        rememberSendTargets([
          chain.dollar,
          chain.launcher,
          chain.holderPause,
          chain.earlier,
        ]);
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

        // ---- Project zero: launched by another account; the deployment gives it the pause and the earlier reserve --------
        const offer = await state.readLaunchOffer(read, chain.launcher);
        expect(offer.holderPause?.lineDivisor).toBe(3);
        await walletOf(founder).sendCalls(
          [
            pot.launchCall({
              launcher: chain.launcher,
              projectId: projectIdOf(coordinate),
              name: "zero",
              symbol: "ZERO",
              ratePpm: 1000,
              teamPool: 10_000_000n * SHARE,
              settingsHash: offer.settingsHash,
            }),
          ],
          CHAIN,
        );
        const parts = await state.readProjectParts(read, chain.launcher, key);
        const treasury = parts.treasury;
        const gate = await reads.pauseGateOf(read, treasury);
        expect(gate).not.toBeNull();
        rememberSendTargets([
          parts.shares,
          parts.team,
          treasury,
          parts.vester,
          gate,
        ]);

        // ---- Claim a row: one operation, one prompt; the acceptance is on the network, a second claim is refused ----------
        const claim = pot.earlierClaimCall({
          contract: chain.earlier as string,
          index: 1n,
          amount: 2_500n * SHARE,
          proof: tree.proofOf(1),
          accepted: textHash,
        });
        expect(
          await reads.earlierRowClaimed(read, chain.earlier as string, 1n),
        ).toBe(false);
        await press([claim]);
        expect(
          await reads.earlierRowClaimed(read, chain.earlier as string, 1n),
        ).toBe(true);
        expect(
          await reads.earlierRowClaimed(read, chain.earlier as string, 0n),
        ).toBe(false);
        // The protected grant is the account's own, of exactly the row's amount.
        const grants = await Promise.all(
          [0n, 1n, 2n].map((id) =>
            state.readGrant(read, parts.vester, id).catch(() => null),
          ),
        );
        expect(
          grants.some((g) => g?.member === me && g.total === 2_500n * SHARE),
        ).toBe(true);
        expect(
          await stoppedWith(sender.sendCalls([claim], CHAIN), "earlier-claim"),
        ).toBe("This grant is already claimed. Nothing changed.");
        pass(
          "a passkey account claims its row of an invented list in one operation and one prompt, and a second claim of the row is refused in the app's words",
        );
        // An account with no row, given another account's proof, is refused by the contract, in words, and nothing is granted.
        const refused = await stoppedWith(
          walletOf(outsider).sendCalls(
            [
              pot.earlierClaimCall({
                contract: chain.earlier as string,
                index: 0n,
                amount: 1_000n * SHARE,
                proof: tree.proofOf(0),
                accepted: textHash,
              }),
            ],
            CHAIN,
          ),
          "earlier-claim",
        );
        expect(refused).toBe(
          "This link is not for the account you are using. Nothing was claimed. Open it with the account it was made for.",
        );
        expect(
          await reads.earlierRowClaimed(read, chain.earlier as string, 0n),
        ).toBe(false);
        pass(
          "another account with this row's proof is refused by the contract in the app's words",
        );

        // ---- Backers: the passkey account holds a bit over a third once it has parked everything ---------------------------
        await walletOf(other).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
        await press([pot.faucetCall(chain.dollar)]);
        const mine = await planBack(read, {
          dollar: chain.dollar,
          treasury,
          amount: 600n * DOLLAR,
        });
        await press(mine!.calls);
        const theirs = await planBack(read, {
          dollar: chain.dollar,
          treasury,
          amount: 1_000n * DOLLAR,
          to: other,
        });
        await walletOf(other).sendCalls(theirs!.calls, CHAIN);
        // (the play dollar's faucet gives 1,000: the second backer put 1,000 in, the passkey account 600)
        const heldAll = await reads.balanceOf(read, parts.shares, me);
        expect(heldAll).toBeGreaterThan(0n);

        // ---- Park half: approve and park are ONE operation of two calls; the line is not reached ---------------------------
        const half = heldAll / 2n;
        await press(
          pot.parkCalls({
            shares: parts.shares,
            pause: gate as string,
            amount: half,
          }),
        );
        expect(await reads.parkedOf(read, gate as string, me)).toBe(half);
        expect((await reads.pauseState(read, gate as string)).armedAt).toBe(0);
        pass(
          "a passkey account parks Shares (approve and park) in one operation and one prompt; under the line nothing is armed",
        );
        // Take some back: one call.
        await press([pot.unparkCall(gate as string, half / 2n)]);
        expect(await reads.parkedOf(read, gate as string, me)).toBe(
          half - half / 2n,
        );
        pass(
          "a passkey account takes parked Shares back in one operation and one prompt",
        );

        // ---- Park the rest: the line is reached, a warning day runs, then the team's draw is refused in the app's words --------
        const rest = await reads.balanceOf(read, parts.shares, me);
        await press(
          pot.parkCalls({
            shares: parts.shares,
            pause: gate as string,
            amount: rest,
          }),
        );
        const armed = await reads.pauseState(read, gate as string);
        expect(armed.armedAt).toBeGreaterThan(0);
        expect(armed.paused).toBe(false);
        // The team checks in and the box fills; before the warning day is over a draw still works.
        // the pause's warning period is a seventh of the unit: 240 seconds on this chain
        await passTime(100);
        await walletOf(founder).sendCalls(
          [pot.checkInCall(treasury, `0x${"5a".repeat(32)}`)],
          CHAIN,
        );
        await walletOf(founder).sendCalls(
          [pot.drawCall({ treasury, to: other, amount: DOLLAR / 10n })],
          CHAIN,
        );
        await passTime(200);
        await walletOf(founder).sendCalls(
          [pot.checkInCall(treasury, `0x${"5b".repeat(32)}`)],
          CHAIN,
        );
        expect((await reads.pauseState(read, gate as string)).paused).toBe(
          true,
        );
        const said = await stoppedWith(
          walletOf(founder).sendCalls(
            [pot.drawCall({ treasury, to: other, amount: DOLLAR / 10n })],
            CHAIN,
          ),
          "draw",
        );
        expect(said).toBe(
          "The team's spending is paused by holders. Try again when parked Shares fall below a third.",
        );
        expect(
          await stoppedWith(
            walletOf(founder).sendCalls(
              [
                pot.announceTaskCall({
                  treasury,
                  what: `0x${"a1".repeat(32)}`,
                  payee: other,
                  maxDollars: 2n * DOLLAR,
                  shareBps: 100,
                }),
              ],
              CHAIN,
            ),
            "plan-task",
          ),
        ).toBe(said);
        pass(
          "with the line reached and the warning day over the team's draw and a new plan are refused in the app's words; the day before, a draw worked",
        );

        // ---- Take out Shares that are parked: ONE operation of two calls (un-park, then leave), and the pause ends ------------
        const parkedNow = await reads.parkedOf(read, gate as string, me);
        const plan = await planTakeOutParked(read, {
          treasury,
          pause: gate,
          holder: me,
          walletShares: 0n,
          parkedShares: parkedNow,
          to: me,
        });
        expect(plan).not.toBeNull();
        expect(plan?.calls).toHaveLength(2);
        const dollarsBefore = await reads.balanceOf(read, chain.dollar, me);
        await press(plan?.calls as pot.PotCall[]);
        const dollarsAfter = await reads.balanceOf(read, chain.dollar, me);
        expect(dollarsAfter - dollarsBefore).toBeGreaterThanOrEqual(
          plan?.minCash as bigint,
        );
        expect(await reads.balanceOf(read, parts.shares, me)).toBe(0n);
        expect(await reads.parkedOf(read, gate as string, me)).toBe(0n);
        expect((await reads.pauseState(read, gate as string)).paused).toBe(
          false,
        );
        // The team's draw works again.
        await walletOf(founder).sendCalls(
          [pot.drawCall({ treasury, to: other, amount: DOLLAR / 10n })],
          CHAIN,
        );
        pass(
          "a passkey holder takes out Shares that are parked in ONE operation of two calls (un-park, then leave) with one prompt, is paid at least the guard, and the pause ends",
        );
      } finally {
        await world.close();
      }
    });
  },
);
