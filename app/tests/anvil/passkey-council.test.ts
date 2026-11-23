// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * The Council and a replace vote from a passkey account, on the real contracts: the account backs, parks half its Shares,
 * opens a replace vote with a list of five in one press, casts its whole weight and moves it in one press each, and then —
 * once the project's runner has handed the seat to a Council the account sits on — proposes a check-in to that Council in
 * one press. A non-seat's proposal is refused by the real Council and reads in the app's own words. Every press goes through
 * the app's own call builders, the sender the app builds (one operation, one passkey prompt, the fee paid by a paymaster) and
 * the app's words. Every row is invented (anvil's public accounts and the passkey account made here). Run by
 * `scripts/phone-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { decodeExecuteCallData } from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { encodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  COUNCIL_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { planBack } from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import {
  forgetSendTargets,
  rememberSendTargets,
} from "../../src/features/money/send-targets";
import { pass, phoneWorld } from "./phone-world";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC, word } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);
/** A day at the harness's 1,680-second time unit: 240 seconds. */
const DAY = 240;

run(
  "the Council and a replace vote from a passkey account, on the real contracts",
  () => {
    it("parks, opens a vote, casts and moves its vote in one press each, then proposes to the Council it sits on", async () => {
      const [admin, founder, other, outsider, fourth, fifth] = await accounts();
      const world = await phoneWorld(admin);
      try {
        const { sender, bundler, authenticator } = world;
        const me = (await sender.getAddress()).toLowerCase();
        const chain = await deployPot(admin, 1680, { council: true });
        expect(chain.council).toBeDefined();
        expect(chain.holderVote).toBe(chain.holderPause);
        forgetSendTargets();
        rememberSendTargets([
          chain.dollar,
          chain.launcher,
          chain.holderPause as string,
          chain.council as string,
        ]);
        const accountRead = (to: string, data: string) =>
          sender.readCall(to, data);

        /** One press: one operation, one prompt, and the operation's call data equals the app's calls in order. */
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

        // ── launch a project from a deployment whose pause is the vote contract and whose Council is bound ──────────
        const coordinate = `37003:${"e5".repeat(32)}:zero`;
        const key = chainKeyOf(founder, projectIdOf(coordinate));
        const projectId = projectIdOf(coordinate);
        const offer = await state.readLaunchOffer(accountRead, chain.launcher);
        expect(offer.holderPause).not.toBeNull();
        await walletOf(founder).sendCalls(
          [
            pot.launchCall({
              launcher: chain.launcher,
              projectId,
              name: "Council probe",
              symbol: "CPRB",
              ratePpm: 1000,
              teamPool: 10_000_000n * SHARE,
              settingsHash: offer.settingsHash,
            }),
          ],
          CHAIN,
        );
        const parts = await state.readProjectParts(read, chain.launcher, key);
        const pause = await reads.pauseGateOf(read, parts.treasury);
        expect(pause).not.toBeNull();
        rememberSendTargets([
          parts.shares,
          parts.team,
          parts.vester,
          pause as string,
        ]);
        pass(
          "a deployment with the Council switch on gives its project the vote contract as its pause, and the app reads it",
        );

        // ── back and park half the Shares, one press each ────────────────────────────────────────────────────────────
        await press([pot.faucetCall(chain.dollar)]);
        const backPlan = await planBack(accountRead, {
          dollar: chain.dollar,
          treasury: parts.treasury,
          amount: 100n * DOLLAR,
        });
        expect(backPlan?.oneSignature).toBe(true);
        await press(backPlan!.calls);
        const held = await reads.balanceOf(read, parts.shares, me);
        expect(held).toBeGreaterThan(0n);
        const parked = held / 2n;
        await press(
          pot.parkCalls({
            shares: parts.shares,
            pause: pause as string,
            amount: parked,
          }),
        );
        expect(await reads.parkedOf(read, pause as string, me)).toBe(parked);
        pass(
          "a passkey account backed and parked half its Shares, one operation and one prompt each",
        );

        // ── open a replace vote with a list of five, in one press ───────────────────────────────────────────────────
        const list = [me, other, outsider, fourth, fifth].map((a) =>
          a.toLowerCase(),
        );
        const recordHash = `0x${"5d".repeat(32)}`;
        await press([
          pot.openReplaceCall({
            vote: pause as string,
            members: list,
            recordHash,
          }),
        ]);
        const opened = await reads.ballotOf(read, pause as string, me);
        expect(opened.id).toBeGreaterThan(0);
        pass(
          "it opened a replace vote with a list of five in one press, and the contract gave it a ballot",
        );

        // ── after the stand window it casts its whole weight, then moves it, one press each ─────────────────────────
        await passTime(DAY + 30);
        await press([pot.castVoteCall(pause as string, 1)]);
        const cast = await reads.ballotOf(read, pause as string, me);
        expect(cast.option).toBe(1);
        expect(cast.weight).toBe(parked);
        await press([pot.castVoteCall(pause as string, 0)]);
        const moved = await reads.ballotOf(read, pause as string, me);
        expect(moved.option).toBe(0);
        expect(moved.weight).toBe(parked);
        pass(
          "it cast its whole weight for the list and moved it back in one press each, at the same weight (the snapshot)",
        );

        // ── the runner hands the seat to a Council the passkey account sits on ──────────────────────────────────────
        const salt = `0x${"77".repeat(32)}`;
        const council = await reads.councilAddressOf(read, chain.launcher, {
          key,
          members: list,
          salt,
        });
        await walletOf(founder).sendCalls(
          [
            pot.handOverCall({
              treasury: parts.treasury,
              next: council,
              founderLeaves: false,
            }),
          ],
          CHAIN,
        );
        await walletOf(admin).sendCalls(
          [
            pot.makeCouncilCall({
              launcher: chain.launcher,
              key,
              members: list,
              salt,
            }),
          ],
          CHAIN,
        );
        const runner = await word(
          parts.treasury,
          encodeCall(TREASURY_ABI, "runner", []),
        );
        expect(`0x${runner.toString(16).padStart(40, "0")}`).toBe(council);
        // The Council clone is a send target too: the app knows the addresses its presses may go to.
        rememberSendTargets([council]);
        const seats = await reads.councilSeats(read, council);
        expect(seats.map((s) => s.account)).toEqual(list);
        pass(
          "the runner handed the seat to a Council whose five seats are the vote's list, and the app reads them",
        );

        // ── the passkey account, a seat, proposes a check-in in one press ───────────────────────────────────────────
        const inner = pot.checkInCall(parts.treasury, `0x${"5c".repeat(32)}`);
        const nonceBefore = await word(
          council,
          encodeCall(COUNCIL_ABI, "nonce", []),
        );
        await press([pot.councilProposeCall(council, inner.to, inner.data)]);
        const nonceAfter = await word(
          council,
          encodeCall(COUNCIL_ABI, "nonce", []),
        );
        expect(nonceAfter).toBe(nonceBefore + 1n);
        pass(
          "a passkey seat proposed a check-in to the Council in one operation and one prompt",
        );

        // ── a non-seat's proposal is refused by the real Council: nothing is recorded ───────────────────────────────
        const nonceBeforeOutsider = await word(
          council,
          encodeCall(COUNCIL_ABI, "nonce", []),
        );
        await walletOf(admin)
          .sendCalls(
            [pot.councilProposeCall(council, inner.to, inner.data)],
            CHAIN,
          )
          .catch(() => {});
        const nonceAfterOutsider = await word(
          council,
          encodeCall(COUNCIL_ABI, "nonce", []),
        );
        expect(nonceAfterOutsider).toBe(nonceBeforeOutsider);
        pass(
          "a non-seat's proposal is refused by the real Council: no proposal number is spent and nothing waits",
        );
      } finally {
        await world.close();
      }
    });
  },
);
