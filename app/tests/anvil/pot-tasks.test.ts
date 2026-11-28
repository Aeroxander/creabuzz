// biome-ignore-all lint/style/noNonNullAssertion: each read is asserted non-null on the line before it is used
/**
 * What a holder reads and does around a task, through the app's own readers, quotes and note finder, against the real contracts
 * on a local chain (step 2, plan section 8.2). Where `pot-task-reads.test.ts` drives the shared library's calls and reads, this
 * file drives what the holder's screens use: the Take out quote that writes a note, the note finder, the Claim sheet's read and
 * figure, and the words of the chain's own refusals. The team's calls that set a task up (plan, pay) are sent with the shared
 * library, since the app has no screen for them. Every number a check compares is read from the chain at that moment; none is
 * typed.
 *
 * One run: a task is planned and taken, a leaver takes out and gets a note, the team pays in part, the leaver claims; a second
 * task is taken and nobody settles it, so it runs out and a stranger returns it, and the holder who left while it was set aside
 * claims the whole. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { expect, it } from "vitest";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import {
  ownNoteSerials,
  rememberStep,
} from "../../src/features/pot/own-history";
import type { MoneyTarget } from "../../src/features/pot/target";
import { trackNotes } from "../../src/features/pot/take-out-notes";
import { readTakeOut } from "../../src/features/pot/takeout-read";
import {
  claimFigure,
  readClaim,
} from "../../src/features/tasks/chain/holder/claim-read";
import { claimNotYet } from "../../src/features/tasks/chain/holder/notes-words";
import {
  noteCandidates,
  readNotes,
} from "../../src/features/tasks/chain/holder/notes-read";
import { phaseOf } from "../../src/features/tasks/chain/state";
import { readTaskNow } from "../../src/features/tasks/chain/team/task-now";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, passTime } from "./rpc";

import {
  CHAIN,
  DOLLAR,
  back,
  checkIn,
  dollars,
  idHex,
  launch,
  potOf,
  read,
  readyOf,
  refused,
  run,
  send,
} from "./pot-tasks-scene";

/** The share of the project's money a plan of `max` asks for: a tenth more than the pay's own share, rounded up (at least 1). */
const shareOf = (max: bigint, pot: bigint): number =>
  Math.max(1, Number((max * 11_000n + pot - 1n) / pot));

run(
  "the holder's side of a task through the app's own readers, on the real contracts",
  () => {
    it("runs plan, take, note, pay in part, claim, run out and return", async () => {
      const [admin, founder, leaver, backer2, worker, stranger] =
        await accounts();
      const chain = { ...(await deployPot(admin)) };
      for (const who of [founder, leaver, backer2, worker, stranger])
        await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
      const A = await launch(chain, founder, "Tasks");
      await back(chain, A, leaver, 100n);
      await back(chain, A, backer2, 100n);

      // ---- Plan: a task for the worker, sent as the team would from the command line ------------------------------------
      await checkIn(founder, A, 1);
      const ID1 = "a1".repeat(32);
      const max1 = 3n * DOLLAR;
      const share1 = shareOf(max1, await potOf(A));
      const notice1 = await reads.readNoticeFor(read, A.treasury, share1);
      await send(
        founder,
        pot.announceTaskCall({
          treasury: A.treasury,
          what: idHex(ID1),
          payee: worker,
          maxDollars: max1,
          shareBps: share1,
        }),
      );
      const plan1 = await readTaskNow(readyOf(founder), A.treasury, 1n, 0);
      expect(plan1.task.state).toBe("announced");
      expect(phaseOf(plan1.task, plan1.time)).toBe("notice");
      // The notice the chain gave is the notice it promised before the plan.
      expect(plan1.task.noticeEnd - plan1.task.announcedAt).toBe(
        notice1.noticeSecs,
      );

      // ---- Take: too early is refused in words, then in time ---------------------------------------------------------
      expect(
        await refused(
          worker,
          pot.takeTaskCall({
            treasury: A.treasury,
            serial: 1n,
            minAmount: max1,
          }),
          "claim-note",
        ),
      ).toEqual(expect.any(String));
      await passTime(notice1.noticeSecs + 5);
      await checkIn(founder, A, 2);
      await send(
        worker,
        pot.takeTaskCall({ treasury: A.treasury, serial: 1n, minAmount: max1 }),
      );
      const taken1 = await readTaskNow(readyOf(worker), A.treasury, 1n, 0);
      expect(taken1.task.state).toBe("taken");
      expect(taken1.task.takenBy).toBe(worker);
      expect(taken1.task.setAside).toBe(max1);
      expect(taken1.task.deadline).toBe(
        (taken1.task.takenAt as number) + notice1.dueSecs,
      );
      expect(phaseOf(taken1.task, taken1.time)).toBe("working");

      // Nobody can return a task before its deadline, and a take-out that comes now writes a note.
      expect(
        await refused(
          stranger,
          pot.returnTaskCall({ treasury: A.treasury, serial: 1n }),
          "claim-note",
        ),
      ).toEqual(expect.any(String));

      // ---- A holder takes out while the money is set aside: the app's own quote, call and note finder ----------------
      const target: MoneyTarget = {
        chainId: CHAIN,
        key: A.key,
        treasury: A.treasury,
        shares: A.shares,
        team: A.team,
        vester: A.vester,
        dollar: chain.dollar,
        playMoney: true,
      };
      const out = await readTakeOut(read, target, "backer", leaver);
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("no take out");
      expect(out.note).toBeGreaterThan(0n);
      const leaverBefore = await dollars(chain, leaver);
      const outTx = await send(leaver, out.call);
      // Exactly the cash the sheet quoted arrives now; the note is owed later.
      expect(
        (await dollars(chain, leaver)) - leaverBefore,
      ).toBeGreaterThanOrEqual(out.minCash);
      rememberStep(leaver, {
        kind: "take-out",
        project: A.key,
        at: taken1.time,
        dollars: String(out.cash),
        shares: String(out.shares),
        txHash: outTx,
      });
      await trackNotes(readyOf(leaver), A.treasury, outTx);
      expect(ownNoteSerials(leaver, A.key)).toEqual([1n]);
      const candidates = noteCandidates({
        queue: null,
        account: leaver,
        own: ownNoteSerials(leaver, A.key),
        found: [],
      });
      expect(candidates).toEqual([1n]);
      const listed = await readNotes(
        readyOf(leaver),
        A.treasury,
        candidates,
        0,
      );
      expect(listed.notes).toHaveLength(1);
      expect(listed.notes[0]!.face).toBe(out.note);
      // Someone who left nothing owed has nothing listed.
      expect(
        (await readNotes(readyOf(backer2), A.treasury, candidates, 0)).notes,
      ).toEqual([]);
      // While the task runs, a claim has no press and the chain refuses it in words.
      const running = await readClaim(readyOf(leaver), A.treasury, 1n, 0);
      const runningFigure = claimFigure(running, running.time);
      expect(runningFigure.claimable).toBe(0n);
      expect(runningFigure.block).toBe(claimNotYet(running.task.deadline!));
      expect(
        await refused(
          leaver,
          pot.claimNoteCall({
            treasury: A.treasury,
            serial: 1n,
            holder: leaver,
          }),
          "claim-note",
        ),
      ).toEqual(expect.any(String));

      // ---- Pay in part: the team's one call, and what it pays goes to the worker and to nobody else -------------------
      const setAside = taken1.task.setAside;
      const pay = 1_500_000n;
      expect(
        await refused(
          stranger,
          pot.acceptTaskCall({
            treasury: A.treasury,
            serial: 1n,
            payDollars: pay,
          }),
          "claim-note",
        ),
      ).toEqual(expect.any(String));
      const workerBefore = await dollars(chain, worker);
      const strangerBefore = await dollars(chain, stranger);
      await send(
        founder,
        pot.acceptTaskCall({
          treasury: A.treasury,
          serial: 1n,
          payDollars: pay,
        }),
      );
      expect((await dollars(chain, worker)) - workerBefore).toBe(pay);
      expect(await dollars(chain, stranger)).toBe(strangerBefore);
      const paid = await readTaskNow(readyOf(founder), A.treasury, 1n, 0);
      expect(paid.task.state).toBe("paid");
      expect(paid.task.returned).toBe(setAside - pay);
      // A second payment is refused by the chain, in words.
      expect(
        await refused(
          founder,
          pot.acceptTaskCall({
            treasury: A.treasury,
            serial: 1n,
            payDollars: pay,
          }),
          "claim-note",
        ),
      ).toEqual(expect.any(String));

      // ---- Claim: the figure the sheet shows is what the claim pays, to the holder and to nobody else ---------------
      const claim = await readClaim(readyOf(leaver), A.treasury, 1n, 0);
      const figure = claimFigure(claim, claim.time);
      expect(figure.block).toBeNull();
      expect(figure.overdue).toBe(false);
      expect(figure.claimable).toBe(claim.view);
      expect(figure.claimable).toBe(
        (claim.face * paid.task.returned) / setAside,
      );
      expect(figure.claimable).toBeGreaterThan(0n);
      const leaverMid = await dollars(chain, leaver);
      const strangerMid = await dollars(chain, stranger);
      await send(
        leaver,
        pot.claimNoteCall({ treasury: A.treasury, serial: 1n, holder: leaver }),
      );
      expect((await dollars(chain, leaver)) - leaverMid).toBe(figure.claimable);
      expect(await dollars(chain, stranger)).toBe(strangerMid);
      const claimed = await readClaim(readyOf(leaver), A.treasury, 1n, 0);
      expect(claimFigure(claimed, claimed.time).block).toEqual(
        expect.any(String),
      );

      // ---- A task that runs out: nobody settles it, a stranger returns it, the holder who left claims the whole -------
      const ID3 = "a3".repeat(32);
      await checkIn(founder, A, 3);
      // The share is the one a plan asks for on the project's money now (it has shrunk since the Take out).
      const share3 = shareOf(2n * DOLLAR, await potOf(A));
      await send(
        founder,
        pot.announceTaskCall({
          treasury: A.treasury,
          what: idHex(ID3),
          payee: worker,
          maxDollars: 2n * DOLLAR,
          shareBps: share3,
        }),
      );
      const notice3 = await reads.readNoticeFor(read, A.treasury, share3);
      await passTime(notice3.noticeSecs + 5);
      await checkIn(founder, A, 4);
      await send(
        worker,
        pot.takeTaskCall({
          treasury: A.treasury,
          serial: 2n,
          minAmount: 2n * DOLLAR,
        }),
      );
      const out2 = await readTakeOut(read, target, "backer", backer2);
      if (!out2.ok) throw new Error("no take out");
      expect(out2.note).toBeGreaterThan(0n);
      const out2Tx = await send(backer2, out2.call);
      // The note finder keeps only the claims its own transaction wrote for its own holder: asked about another transaction, or
      // about a holder who wrote none there, it keeps nothing (a claim of someone else's never lands in a person's history).
      const elsewhere = `0x${"e1".repeat(32)}`;
      for (const [who, tx] of [
        [leaver, out2Tx],
        [backer2, outTx],
      ] as const) {
        rememberStep(who, {
          kind: "take-out",
          project: elsewhere,
          at: taken1.time,
          dollars: "1",
          shares: "1",
          txHash: tx,
        });
        await trackNotes(readyOf(who), A.treasury, tx);
        expect(ownNoteSerials(who, elsewhere)).toEqual([]);
      }
      await passTime(notice3.dueSecs + 5);
      const overdue = await readTaskNow(readyOf(stranger), A.treasury, 2n, 0);
      expect(overdue.task.state).toBe("taken");
      expect(phaseOf(overdue.task, overdue.time)).toBe("overdue");
      // Nobody settled it, so the chain still says taken, and the team cannot pay it any more: it settles first and refuses.
      expect(
        await refused(
          founder,
          pot.acceptTaskCall({
            treasury: A.treasury,
            serial: 2n,
            payDollars: DOLLAR,
          }),
          "claim-note",
        ),
      ).toEqual(expect.any(String));
      // The chain's own claim view reads nothing; the app's figure is the whole claim, as a claim settles first and returns it.
      const lateClaim = await readClaim(readyOf(backer2), A.treasury, 2n, 0);
      expect(lateClaim.view).toBe(0n);
      const lateFigure = claimFigure(lateClaim, lateClaim.time);
      expect(lateFigure).toMatchObject({ overdue: true, block: null });
      expect(lateFigure.claimable).toBe(lateClaim.face);
      await send(
        stranger,
        pot.returnTaskCall({ treasury: A.treasury, serial: 2n }),
      );
      const returned = await readTaskNow(readyOf(stranger), A.treasury, 2n, 0);
      expect(returned.task.state).toBe("returned");
      expect(returned.task.returned).toBe(returned.task.setAside);
      const afterClaim = await readClaim(readyOf(backer2), A.treasury, 2n, 0);
      const afterFigure = claimFigure(afterClaim, afterClaim.time);
      expect(afterFigure.overdue).toBe(false);
      // What it pays after the return is what the figure said before it.
      expect(afterFigure.claimable).toBe(lateFigure.claimable);
      expect(afterFigure.claimable).toBe(afterClaim.view);
      const b2Before = await dollars(chain, backer2);
      await send(
        backer2,
        pot.claimNoteCall({
          treasury: A.treasury,
          serial: 2n,
          holder: backer2,
        }),
      );
      expect((await dollars(chain, backer2)) - b2Before).toBe(
        afterFigure.claimable,
      );
    });
  },
);
