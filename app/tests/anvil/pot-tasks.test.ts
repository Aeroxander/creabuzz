// biome-ignore-all lint/style/noNonNullAssertion: each read is asserted non-null on the line before it is used
/**
 * The task queue through the app's own readers, gates and call builders, against the real contracts on a local chain
 * (step 2, plan section 8.2, F2). Where `pot-task-reads.test.ts` drives the shared library's calls and reads, this file
 * drives what the screens use: the Plan sheet's read and its `landed` look, the Take sheet's read and gate, the pay sheet's
 * gate and amount, the Claim sheet's read and figure, the notes list, the transaction the team's record names, the words of
 * every refusal, and a Pair's whole round for a plan and for a payment with both signers. Every number a check compares is
 * read from the chain at that moment; none is typed.
 *
 * One run: a task is planned, withdrawn, taken early (refused) and in time, a leaver takes out and gets a note, the team pays
 * in part, the leaver claims; a second task is taken and nobody settles it, so it runs out and a stranger returns it, and the
 * holder who left while it was set aside claims the whole; a third is sent back; a project run by two plans and pays a task
 * with both signers. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { expect, it } from "vitest";
import { topicOf } from "../../../packages/creaton-core/src/launchpad/work.ts";
import {
  LAUNCHER_ABI,
  TASK_BOOK_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import {
  describePotCall,
  type PairTaskFacts,
} from "../../src/features/pot/pair-terms";
import {
  ownNoteSerials,
  rememberStep,
} from "../../src/features/pot/own-history";
import { runnerSend } from "../../src/features/pot/runner-calls";
import type { MoneyTarget } from "../../src/features/pot/target";
import { trackNotes } from "../../src/features/pot/take-out-notes";
import { readTakeOut } from "../../src/features/pot/takeout-read";
import {
  proposalOf,
  readPairWaiting,
} from "../../src/features/pot/use-pair-waiting";
import { shareFor } from "../../src/features/tasks/chain/door";
import { durationWords } from "../../src/features/tasks/chain/duration";
import {
  claimFigure,
  readClaim,
} from "../../src/features/tasks/chain/holder/claim-read";
import { claimNotYet } from "../../src/features/tasks/chain/holder/notes-words";
import {
  noteCandidates,
  readNotes,
} from "../../src/features/tasks/chain/holder/notes-read";
import { takeBlock } from "../../src/features/tasks/chain/holder/take-gate";
import {
  TAKE_BLOCK,
  takeNotice,
  takeNotPayee,
} from "../../src/features/tasks/chain/holder/holder-words";
import { readTake } from "../../src/features/tasks/chain/holder/take-read";
import {
  acceptGate,
  canReturn,
  canSendBack,
  canWithdraw,
  phaseOf,
  tieOf,
} from "../../src/features/tasks/chain/state";
import { partPay } from "../../src/features/tasks/chain/team/amount";
import { readPaidTx } from "../../src/features/tasks/chain/team/paid-tx";
import {
  hypotheticalRow,
  plannedAlready,
  plannedSince,
  readPlan,
} from "../../src/features/tasks/chain/team/plan-read";
import {
  readTaskNow,
  stillSo,
} from "../../src/features/tasks/chain/team/task-now";
import {
  acceptTaskWords,
  announceTaskWords,
  dollarsPhrase,
  NOT_RUNNER,
  notThisTask,
  rejectTaskWords,
} from "../../src/features/tasks/chain/words";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, passTime } from "./rpc";

import {
  CHAIN,
  DOLLAR,
  FOUNDER_KEY,
  back,
  checkIn,
  dollars,
  idHex,
  launch,
  numbersOf,
  potOf,
  read,
  readyOf,
  record,
  refused,
  rowOf,
  run,
  send,
  view,
} from "./pot-tasks-scene";

run(
  "the task queue through the app's own readers and gates, on the real contracts",
  () => {
    it("runs plan, withdraw, take, note, pay in part, claim, run out and return, send back", async () => {
      const [admin, founder, leaver, backer2, worker, stranger, second] =
        await accounts();
      const chain = { ...(await deployPot(admin)) };
      for (const who of [founder, leaver, backer2, worker, stranger, second])
        await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
      const A = await launch(chain, founder, "Tasks");
      await back(chain, A, leaver, 100n);
      await back(chain, A, backer2, 100n);

      const maxShare = Number(
        (await view(TASK_BOOK_ABI, A.book, "MAX_SHARE_BPS"))[0],
      );
      const runnerA = { address: founder, isPair: false, signers: null };
      const links = {
        founder: FOUNDER_KEY,
        agents: new Set<string>(),
        operators: new Map<string, string>(),
      };
      const team = new Set([FOUNDER_KEY]);

      // ---- Plan: the sheet's read, the one call it builds, and what the network holds afterwards ----------------------
      await checkIn(founder, A, 1);
      const ID1 = "a1".repeat(32);
      const ID2 = "a2".repeat(32);
      const task1 = record(ID1, 3, worker);
      const max1 = BigInt(task1.usd!) * DOLLAR;
      const pot0 = await potOf(A);
      const share1 = shareFor(max1, pot0, maxShare);
      expect(share1).not.toBeNull();
      const before = await readPlan(
        { read, wallet: walletOf(founder) },
        A.treasury,
        share1,
        0,
      );
      expect(before.book).toBe(A.book);
      expect(before.nextSerial).toBe(1n);
      expect(before.open).toEqual([]);
      expect(before.notice).not.toBeNull();
      expect(before.activeEnd).toBeGreaterThan(before.time);
      expect(plannedAlready(before, ID1)).toBeNull();
      expect(tieOf(hypotheticalRow(task1, max1, share1!), task1)).toEqual({
        ok: true,
      });
      const planned = await send(
        founder,
        pot.announceTaskCall({
          treasury: A.treasury,
          what: idHex(ID1),
          payee: worker,
          maxDollars: max1,
          shareBps: share1!,
        }),
      );
      expect(planned).toMatch(/^0x[0-9a-f]{64}$/);
      const after = await readPlan(
        { read, wallet: walletOf(founder) },
        A.treasury,
        share1,
        0,
      );
      const plan1 = plannedAlready(after, ID1)!;
      expect(plan1.serial).toBe(1n);
      expect(plan1.state).toBe("announced");
      // The notice the sheet promised is the notice the chain gave.
      expect(plan1.noticeEnd - plan1.announcedAt).toBe(
        before.notice!.noticeSecs,
      );
      expect(plan1.expiresAt - plan1.noticeEnd).toBe(
        before.notice!.takeWindowSecs,
      );
      expect(plan1.maxDollars).toBe(max1);
      expect(plan1.shareBps).toBe(share1);
      // A call replaced in the wallet may have landed under another hash: the look for it finds this plan, and only this one.
      expect(await plannedSince(read, A.treasury, idHex(ID1), "1")).toBe(true);
      expect(await plannedSince(read, A.treasury, idHex(ID2), "1")).toBe(false);
      expect(await plannedSince(read, A.treasury, idHex(ID1), "2")).toBe(false);
      expect(await plannedSince(read, A.treasury, idHex(ID1), "x")).toBe(false);
      expect(await plannedSince(read, A.treasury, idHex(ID1), undefined)).toBe(
        false,
      );

      // ---- Withdraw: a second plan, open to anyone, is withdrawn before anyone takes it -----------------------------
      await send(
        founder,
        pot.announceTaskCall({
          treasury: A.treasury,
          what: idHex(ID2),
          payee: null,
          maxDollars: 2n * DOLLAR,
          shareBps: 100,
        }),
      );
      const open2 = await readTaskNow(readyOf(founder), A.treasury, 2n, 0);
      expect(canWithdraw(open2.task, open2.time)).toBe(true);
      expect(canSendBack(open2.task, open2.time)).toBe(false);
      await send(
        founder,
        pot.cancelTaskCall({ treasury: A.treasury, serial: 2n }),
      );
      const gone = await readTaskNow(readyOf(founder), A.treasury, 2n, 0);
      expect(gone.task.state).toBe("cancelled");
      expect(canWithdraw(gone.task, gone.time)).toBe(false);
      // The sheet's last look: what it showed is not what the chain says now, and the sentence says what became of it.
      expect(
        stillSo({
          shown: open2.task,
          fresh: gone,
          waiting: false,
          result: "cancelled",
        }),
      ).toEqual(expect.any(String));
      // A send of this very step that may have landed is not a change: the sheet looks for it instead.
      expect(
        stillSo({
          shown: open2.task,
          fresh: gone,
          waiting: true,
          result: "cancelled",
        }),
      ).toBeNull();
      // Withdrawing it again is refused in words, and nothing moves.
      expect(
        await refused(
          founder,
          pot.cancelTaskCall({ treasury: A.treasury, serial: 2n }),
          "withdraw-task",
        ),
      ).toEqual(expect.any(String));

      // ---- Take: too early is refused in the words the gate says, then in time ---------------------------------------
      const money1 = numbersOf(A, chain, runnerA, pot0);
      const queue = (roomBps: number) =>
        ({
          cap: { usedBps: 0, roomBps, frees: [] },
          limits: { capBps: 1000 },
        }) as never;
      const early = await readTake(readyOf(worker), A.treasury, 1n, 0);
      expect(
        takeBlock({
          read: early,
          numbers: money1,
          queue: queue(early.roomBps),
          address: worker,
          now: early.time,
        }),
      ).toBe(takeNotice(plan1.noticeEnd));
      expect(
        await refused(
          worker,
          pot.takeTaskCall({
            treasury: A.treasury,
            serial: 1n,
            minAmount: max1,
          }),
          "take-task",
        ),
      ).toBe(takeNotice(plan1.noticeEnd));
      // Not the named wallet: the gate says so, and so does the chain.
      expect(
        takeBlock({
          read: early,
          numbers: money1,
          queue: queue(early.roomBps),
          address: stranger,
          now: early.time,
        }),
      ).toBe(takeNotPayee(worker));
      // The team that runs the project cannot take its own task.
      expect(
        takeBlock({
          read: early,
          numbers: money1,
          queue: queue(early.roomBps),
          address: founder,
          now: early.time,
        }),
      ).toBe(TAKE_BLOCK.runs);

      await passTime(before.notice!.noticeSecs + 5);
      await checkIn(founder, A, 2);
      const ready1 = await readTake(readyOf(worker), A.treasury, 1n, 0);
      expect(
        takeBlock({
          read: ready1,
          numbers: numbersOf(A, chain, runnerA, await potOf(A)),
          queue: queue(ready1.roomBps),
          address: worker,
          now: ready1.time,
        }),
      ).toBeNull();
      // A stranger is refused by the chain too, in words.
      expect(
        await refused(
          stranger,
          pot.takeTaskCall({
            treasury: A.treasury,
            serial: 1n,
            minAmount: max1,
          }),
          "take-task",
        ),
      ).toEqual(expect.any(String));
      // "Take it only if the whole most is set aside": the minimum is the fresh read's most.
      await send(
        worker,
        pot.takeTaskCall({
          treasury: A.treasury,
          serial: 1n,
          minAmount: ready1.task.maxDollars,
        }),
      );
      const taken1 = await readTaskNow(readyOf(worker), A.treasury, 1n, 0);
      expect(taken1.task.state).toBe("taken");
      expect(taken1.task.takenBy).toBe(worker);
      expect(taken1.task.setAside).toBe(max1);
      expect(taken1.task.deadline).toBe(
        (taken1.task.takenAt as number) + before.notice!.dueSecs,
      );
      expect(phaseOf(taken1.task, taken1.time)).toBe("working");

      // Nobody can return a task before its deadline, and a take-out that comes now writes a note.
      expect(canReturn(taken1.task, taken1.time)).toBe(false);
      expect(
        await refused(
          stranger,
          pot.returnTaskCall({ treasury: A.treasury, serial: 1n }),
          "return-task",
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
      const out = await readTakeOut(read, target, "backer", "half", leaver);
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

      // ---- Pay in part: the sheet's gate, its amount rules, one call, and the payment's own transaction ---------------
      const fresh = await readTaskNow(readyOf(founder), A.treasury, 1n, 0);
      const gate = (over: Partial<Parameters<typeof acceptGate>[0]> = {}) =>
        acceptGate({
          fresh: fresh.task,
          shown: rowOf(fresh.task),
          relay: task1,
          now: fresh.time,
          me: FOUNDER_KEY,
          address: founder,
          runner: runnerA,
          team,
          links,
          ...over,
        });
      expect(gate()).toEqual({ ok: true });
      const notRunner = gate({ address: stranger });
      expect(notRunner.ok).toBe(false);
      expect(!notRunner.ok && notRunner.sentence).toBe(NOT_RUNNER);
      // A record that names another wallet than the one that took the task is not paid.
      const otherWallet = gate({ relay: record(ID1, 3, stranger) });
      expect(!otherWallet.ok && otherWallet.sentence).toBe(
        notThisTask("payee"),
      );
      // The amounts the sheet accepts: dollars and cents, at least a dollar, at most what is set aside.
      const setAside = fresh.task.setAside;
      expect(partPay("0.5", setAside).ok).toBe(false);
      expect(partPay("4", setAside).ok).toBe(false);
      expect(partPay("1.505", setAside).ok).toBe(false);
      const part = partPay("1.5", setAside);
      expect(part).toMatchObject({ ok: true, raw: 1_500_000n });
      const pay = (part as { raw: bigint }).raw;
      expect(
        await refused(
          stranger,
          pot.acceptTaskCall({
            treasury: A.treasury,
            serial: 1n,
            payDollars: pay,
          }),
          "pay-task",
        ),
      ).toEqual(expect.any(String));
      const workerBefore = await dollars(chain, worker);
      const strangerBefore = await dollars(chain, stranger);
      const payTx = await send(
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
      // The team's record names the very transaction that paid, read from the book by the task's number.
      expect(await readPaidTx(walletOf(founder), A.book, 1n, 0)).toBe(payTx);
      expect(await readPaidTx(walletOf(founder), A.book, 99n, 0)).toBeNull();
      // A second payment is not offered, and the chain refuses it.
      const again = acceptGate({
        fresh: paid.task,
        shown: rowOf(paid.task),
        relay: task1,
        now: paid.time,
        me: FOUNDER_KEY,
        address: founder,
        runner: runnerA,
        team,
        links,
      });
      expect(again.ok).toBe(false);
      expect(
        await refused(
          founder,
          pot.acceptTaskCall({
            treasury: A.treasury,
            serial: 1n,
            payDollars: pay,
          }),
          "pay-task",
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
      const task3 = record(ID3, 2, worker);
      await checkIn(founder, A, 3);
      // The share is the one the Plan sheet would ask for on the project's money now (it has shrunk since the Take out).
      const share3 = shareFor(2n * DOLLAR, await potOf(A), maxShare)!;
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
          serial: 3n,
          minAmount: 2n * DOLLAR,
        }),
      );
      const out2 = await readTakeOut(read, target, "backer", "half", backer2);
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
      const overdue = await readTaskNow(readyOf(stranger), A.treasury, 3n, 0);
      expect(overdue.task.state).toBe("taken");
      expect(phaseOf(overdue.task, overdue.time)).toBe("overdue");
      expect(canReturn(overdue.task, overdue.time)).toBe(true);
      expect(canSendBack(overdue.task, overdue.time)).toBe(false);
      expect(canWithdraw(overdue.task, overdue.time)).toBe(false);
      // The team cannot pay it any more: the gate says the deadline passed, and the chain settles first and refuses.
      const late = acceptGate({
        fresh: overdue.task,
        shown: rowOf(overdue.task),
        relay: task3,
        now: overdue.time,
        me: FOUNDER_KEY,
        address: founder,
        runner: runnerA,
        team,
        links,
      });
      expect(late.ok).toBe(false);
      // The chain's own claim view reads nothing; the app's figure is the whole claim, as a claim settles first and returns it.
      const lateClaim = await readClaim(readyOf(backer2), A.treasury, 3n, 0);
      expect(lateClaim.view).toBe(0n);
      const lateFigure = claimFigure(lateClaim, lateClaim.time);
      expect(lateFigure).toMatchObject({ overdue: true, block: null });
      expect(lateFigure.claimable).toBe(lateClaim.face);
      await send(
        stranger,
        pot.returnTaskCall({ treasury: A.treasury, serial: 3n }),
      );
      const returned = await readTaskNow(readyOf(stranger), A.treasury, 3n, 0);
      // The payment of task 1 is still the payment of task 1 now that other tasks have ended: the look is by the task's number.
      expect(await readPaidTx(walletOf(founder), A.book, 1n, 0)).toBe(payTx);
      expect(await readPaidTx(walletOf(founder), A.book, 3n, 0)).not.toBe(
        payTx,
      );
      expect(returned.task.state).toBe("returned");
      expect(returned.task.returned).toBe(returned.task.setAside);
      const afterClaim = await readClaim(readyOf(backer2), A.treasury, 3n, 0);
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
          serial: 3n,
          holder: backer2,
        }),
      );
      expect((await dollars(chain, backer2)) - b2Before).toBe(
        afterFigure.claimable,
      );

      // ---- Send back: taken, then sent back; nobody is paid and the room under the limit comes back ------------------
      const ID4 = "a4".repeat(32);
      const task4 = record(ID4, 2, worker);
      await checkIn(founder, A, 5);
      const share4 = shareFor(2n * DOLLAR, await potOf(A), maxShare)!;
      await send(
        founder,
        pot.announceTaskCall({
          treasury: A.treasury,
          what: idHex(ID4),
          payee: worker,
          maxDollars: 2n * DOLLAR,
          shareBps: share4,
        }),
      );
      const notice4 = await reads.readNoticeFor(read, A.treasury, share4);
      await passTime(notice4.noticeSecs + 5);
      await checkIn(founder, A, 6);
      await send(
        worker,
        pot.takeTaskCall({
          treasury: A.treasury,
          serial: 4n,
          minAmount: 2n * DOLLAR,
        }),
      );
      const roomTaken = await reads.readTakeRoom(read, A.book);
      const running4 = await readTaskNow(readyOf(founder), A.treasury, 4n, 0);
      expect(canSendBack(running4.task, running4.time)).toBe(true);
      expect(
        acceptGate({
          fresh: running4.task,
          shown: rowOf(running4.task),
          relay: task4,
          now: running4.time,
          me: FOUNDER_KEY,
          address: founder,
          runner: runnerA,
          team,
          links,
        }),
      ).toEqual({ ok: true });
      const workerKept = await dollars(chain, worker);
      await send(
        founder,
        pot.rejectTaskCall({ treasury: A.treasury, serial: 4n }),
      );
      const sentBack = await readTaskNow(readyOf(founder), A.treasury, 4n, 0);
      expect(sentBack.task.state).toBe("rejected");
      expect(sentBack.task.returned).toBe(sentBack.task.setAside);
      expect(await dollars(chain, worker)).toBe(workerKept);
      expect(await reads.readTakeRoom(read, A.book)).toBeGreaterThan(roomTaken);
      expect(canSendBack(sentBack.task, sentBack.time)).toBe(false);

      // A plan nobody takes in its window is over: it cannot be withdrawn (the network settles it first), and the chain says so.
      await checkIn(founder, A, 7);
      const ID6 = "a6".repeat(32);
      const share6 = shareFor(2n * DOLLAR, await potOf(A), maxShare)!;
      await send(
        founder,
        pot.announceTaskCall({
          treasury: A.treasury,
          what: idHex(ID6),
          payee: worker,
          maxDollars: 2n * DOLLAR,
          shareBps: share6,
        }),
      );
      const notice6 = await reads.readNoticeFor(read, A.treasury, share6);
      const waiting6 = await readTaskNow(readyOf(founder), A.treasury, 5n, 0);
      expect(canWithdraw(waiting6.task, waiting6.time)).toBe(true);
      await passTime(notice6.noticeSecs + notice6.takeWindowSecs + 5);
      const missed = await readTaskNow(readyOf(founder), A.treasury, 5n, 0);
      expect(missed.task.state).toBe("announced");
      expect(phaseOf(missed.task, missed.time)).toBe("missed");
      expect(canWithdraw(missed.task, missed.time)).toBe(false);
      expect(
        await refused(
          founder,
          pot.cancelTaskCall({ treasury: A.treasury, serial: 5n }),
          "withdraw-task",
        ),
      ).toEqual(expect.any(String));

      // ---- A project run by two: plan and pay a task, with both signers, in words --------------------------------------
      const B = await launch(chain, founder, "Pairs");
      await back(chain, B, second, 100n);
      await back(chain, B, leaver, 100n);
      const [pairAddress] = (await view(
        LAUNCHER_ABI,
        chain.launcher,
        "pairAddress",
        [B.key, founder, second],
      )) as [string];
      const pair = pairAddress.toLowerCase();
      await send(
        founder,
        pot.handOverCall({
          treasury: B.treasury,
          next: pairAddress,
          founderLeaves: false,
        }),
      );
      await send(second, pot.makePairCall(chain.launcher, B.key, founder));
      const runnerB = {
        address: pair,
        isPair: true,
        signers: [founder, second],
      };
      const potB = await potOf(B);
      const numbersB = numbersOf(B, chain, runnerB, potB);
      await send(
        founder,
        pot.pairCheckInCall(pairAddress, `0x${"5a".repeat(32)}`),
      );

      const ID5 = "a5".repeat(32);
      const max5 = 3n * DOLLAR;
      const share5 = shareFor(max5, potB, maxShare)!;
      const notice5 = await reads.readNoticeFor(read, B.treasury, share5);
      const proposal5 = runnerSend(
        numbersB,
        founder,
        pot.announceTaskCall({
          treasury: B.treasury,
          what: idHex(ID5),
          payee: worker,
          maxDollars: max5,
          shareBps: share5,
        }),
      )!;
      expect(proposal5.through).toBe("pair");
      await send(founder, proposal5.calls[0]!);
      expect(
        plannedAlready(
          await readPlan(
            { read, wallet: walletOf(founder) },
            B.treasury,
            share5,
            0,
          ),
          ID5,
        ),
      ).toBeNull();

      const waitingPlan = await readPairWaiting(
        readyOf(second),
        pair,
        B.treasury,
      );
      expect(waitingPlan.waiting).toHaveLength(1);
      const asked = waitingPlan.waiting[0]!;
      expect(asked.by).toBe(founder);
      const factsOf = (
        f: NonNullable<typeof waitingPlan.facts>,
        words: string | null = null,
      ): PairTaskFacts => ({
        taskFacts: (serial) => f.tasks.get(String(serial)) ?? null,
        noticeFor: (share) => f.notices.get(share) ?? null,
        now: f.now,
        recordWords: () => words,
      });
      const named = (a: string) => a;
      const planTerms = describePotCall(
        numbersB,
        asked.target,
        asked.data,
        named,
        undefined,
        factsOf(waitingPlan.facts!, "Translate the guide"),
      );
      expect(planTerms.kind).toBe("announce-task");
      expect(planTerms.words).toBe(
        announceTaskWords({
          max: max5,
          who: `${worker} (${worker})`,
          shareBps: share5,
          notice: durationWords(notice5.noticeSecs),
          from: waitingPlan.facts!.now + notice5.noticeSecs,
          window: durationWords(notice5.takeWindowSecs),
          due: durationWords(notice5.dueSecs),
        }),
      );
      // Without what the network says, a plan is never said as if it were known, and cannot be confirmed from here.
      expect(
        describePotCall(numbersB, asked.target, asked.data, named).kind,
      ).toBe("unknown");
      expect(
        describePotCall(numbersB, asked.target, asked.data, named, undefined, {
          ...factsOf(waitingPlan.facts!),
          noticeFor: () => null,
        }).kind,
      ).toBe("unknown");
      await send(
        second,
        pot.pairConfirmCall(pair, asked.target, asked.data, asked.nonce),
      );
      const planned5 = plannedAlready(
        await readPlan(
          { read, wallet: walletOf(second) },
          B.treasury,
          share5,
          0,
        ),
        ID5,
      )!;
      expect(planned5.serial).toBe(1n);
      expect(planned5.noticeEnd - planned5.announcedAt).toBe(
        notice5.noticeSecs,
      );
      expect(
        (await readPairWaiting(readyOf(second), pair, B.treasury)).waiting,
      ).toEqual([]);

      await passTime(notice5.noticeSecs + 5);
      await send(
        founder,
        pot.pairCheckInCall(pairAddress, `0x${"5b".repeat(32)}`),
      );
      await send(
        worker,
        pot.takeTaskCall({ treasury: B.treasury, serial: 1n, minAmount: max5 }),
      );
      const taken5 = await readTaskNow(readyOf(second), B.treasury, 1n, 0);
      expect(taken5.task.setAside).toBe(max5);

      // The founder asks to pay 1.2 dollars; the second signer reads the task from the network, in words, and confirms.
      const pay5 = 1_200_000n;
      const payProposal = runnerSend(
        numbersB,
        founder,
        pot.acceptTaskCall({
          treasury: B.treasury,
          serial: 1n,
          payDollars: pay5,
        }),
      )!;
      expect(payProposal.through).toBe("pair");
      await send(founder, payProposal.calls[0]!);
      const waitingPay = await readPairWaiting(
        readyOf(second),
        pair,
        B.treasury,
      );
      expect(waitingPay.waiting).toHaveLength(1);
      const askedPay = waitingPay.waiting[0]!;
      const payTerms = describePotCall(
        numbersB,
        askedPay.target,
        askedPay.data,
        named,
        undefined,
        factsOf(waitingPay.facts!, "Translate the guide"),
      );
      expect(payTerms.kind).toBe("accept-task");
      expect(payTerms.words).toBe(
        acceptTaskWords({
          pay: pay5,
          setAside: taken5.task.setAside,
          serial: 1n,
          who: `${worker} (${worker})`,
        }),
      );
      expect(payTerms.words).toContain(dollarsPhrase(pay5));
      expect(payTerms.more?.join(" ")).toContain("Translate the guide");
      // A call about a task the network cannot say reads as unknown, and is not offered for confirming.
      expect(
        describePotCall(
          numbersB,
          askedPay.target,
          askedPay.data,
          named,
          undefined,
          {
            ...factsOf(waitingPay.facts!),
            taskFacts: () => null,
          },
        ).kind,
      ).toBe("unknown");
      const workerB = await dollars(chain, worker);
      await send(
        second,
        pot.pairConfirmCall(
          pair,
          askedPay.target,
          askedPay.data,
          askedPay.nonce,
        ),
      );
      expect((await dollars(chain, worker)) - workerB).toBe(pay5);
      const paid5 = await readTaskNow(readyOf(second), B.treasury, 1n, 0);
      expect(paid5.task.state).toBe("paid");
      expect(paid5.task.returned).toBe(max5 - pay5);

      // A send back that was asked before the payment landed names a task that has moved: it reads as unknown and cannot be confirmed.
      const staleAsk = runnerSend(
        numbersB,
        founder,
        pot.rejectTaskCall({ treasury: B.treasury, serial: 1n }),
      )!;
      await send(founder, staleAsk.calls[0]!);
      const waitingStale = await readPairWaiting(
        readyOf(second),
        pair,
        B.treasury,
      );
      expect(waitingStale.waiting).toHaveLength(1);
      const staleTerms = describePotCall(
        numbersB,
        waitingStale.waiting[0]!.target,
        waitingStale.waiting[0]!.data,
        named,
        undefined,
        factsOf(waitingStale.facts!),
      );
      expect(staleTerms.kind).toBe("unknown");
      expect(staleTerms.words).not.toBe(rejectTaskWords(1n));
      // And the proposal itself is the Pair's own log, so a proposal id read back is the one the second signer would confirm.
      const logs = await walletOf(second).getLogs({
        address: pair,
        topics: [topicOf("Proposed(bytes32,address,address,bytes,uint256)")],
        from: 0,
        to: await walletOf(second).blockNumber(),
      });
      expect(logs.map((log) => proposalOf(log, pair)?.id)).toContain(
        waitingStale.waiting[0]!.id,
      );
    });
  },
);
