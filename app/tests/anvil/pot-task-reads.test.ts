// biome-ignore-all lint/style/noNonNullAssertion: each read is asserted non-null on the line before it is used
/**
 * The seven task calls and the task reads (S1 of the step 2 server and app plan) on a real EVM, driven only through the
 * app's own call builders, readers and wallet: plan, withdraw, take (early and in time), a take out that writes a note, pay in
 * part, a claim sent by a stranger for someone else, send back, run out and return, and a plan that lapses. Run by
 * `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 *
 * With `S1_CAPTURE_OUT=<file>` it also writes the raw answers of the reads, the vectors in
 * `packages/creaton-core/src/pot/testdata/task-answers.json` (the core tests read them without a chain).
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  type Abi,
  decodeRevert,
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import {
  planBack,
  planTakeOut,
} from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import type { NoteLog } from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { potProblem } from "../../src/features/money/problems";
import {
  type MoneyWallet,
  WalletStepError,
} from "../../src/features/money/wallet";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC, rpc, blockNumber } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);
const OUT = process.env.S1_CAPTURE_OUT ?? "";

async function view(
  abi: Abi,
  to: string,
  name: string,
  args: (bigint | string)[] = [],
) {
  return decodeReturn(
    abi,
    name,
    await read(to, encodeCall(abi, name, args)),
    args.length,
  );
}

run(
  "the task calls and reads on the real contracts, through the app's own builders",
  () => {
    it("runs a task from plan to claim, and the refusals in words", async () => {
      const [admin, founder, backer1, backer2, worker, stranger] =
        await accounts();
      const chain = await deployPot(admin);
      const w = Object.fromEntries(
        [founder, backer1, backer2, worker, stranger].map((a) => [
          a,
          walletOf(a),
        ]),
      );
      for (const who of [founder, backer1, backer2, worker, stranger])
        await w[who].sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
      const [settingsHash] = await view(
        LAUNCHER_ABI,
        chain.launcher,
        "settingsHash",
      );
      const projectId = projectIdOf(`37001:${"ab".repeat(32)}:s1`);
      await w[founder].sendCalls(
        [
          pot.launchCall({
            launcher: chain.launcher,
            projectId,
            name: "S1",
            symbol: "SONE",
            ratePpm: 1000,
            teamPool: 10_000_000n * SHARE,
            settingsHash: settingsHash as string,
          }),
        ],
        CHAIN,
      );
      const [project] = await view(LAUNCHER_ABI, chain.launcher, "project", [
        founder,
        projectId,
      ]);
      const [, shares, , treasury] = project as string[];
      const T = treasury as string;
      const book = await reads.readBookOf(read, T);
      expect(book).not.toBeNull();
      const B = book as string;
      expect(chainKeyOf(founder, projectId)).toBeTruthy();

      for (const [who, amount] of [
        [backer1, 100n],
        [backer2, 100n],
      ] as const) {
        const plan = await planBack(read, {
          dollar: chain.dollar,
          treasury: T,
          amount: amount * DOLLAR,
          to: who,
        });
        await w[who].sendCalls(plan!.calls, CHAIN);
      }
      const cap: Record<string, unknown> = {
        chain: {
          treasury: T,
          book: B,
          unit: chain.unit,
          founder,
          backer1,
          backer2,
          worker,
          stranger,
        },
      };
      const raw = async (
        abi: Abi,
        to: string,
        name: string,
        args: (bigint | string)[] = [],
      ) => ({
        to,
        call: encodeCall(abi, name, args),
        answer: await read(to, encodeCall(abi, name, args)),
      });
      cap.unit = await raw(TREASURY_ABI, T, "unit");
      cap.tasks = await raw(TREASURY_ABI, T, "tasks");
      cap.activeEnd = await raw(TREASURY_ABI, T, "activeEnd");
      cap.noticeFor250 = await raw(TREASURY_ABI, T, "noticeFor", [250n]);
      cap.takeRoom0 = await raw(TASK_BOOK_ABI, B, "takeRoomBps");
      cap.taskOf99 = await raw(TASK_BOOK_ABI, B, "taskOf", [99n]);
      cap.openSerials0 = await raw(TASK_BOOK_ABI, B, "openSerials");
      expect(await reads.readTask(read, B, 99n)).toBeNull();
      expect(await reads.readOpenSerials(read, B)).toEqual([]);
      expect(await reads.readUnit(read, T)).toBe(chain.unit);

      // Plan: T1 for the worker, T2 for anyone, then T2 is withdrawn.
      await w[founder].sendCalls(
        [pot.checkInCall(T, `0x${"5a".repeat(32)}`)],
        CHAIN,
      );
      const WHAT1 = `0x${"11".repeat(32)}`;
      const WHAT2 = `0x${"22".repeat(32)}`;
      await w[founder].sendCalls(
        [
          pot.announceTaskCall({
            treasury: T,
            what: WHAT1,
            payee: worker,
            maxDollars: 3n * DOLLAR,
            shareBps: 250,
          }),
        ],
        CHAIN,
      );
      await w[founder].sendCalls(
        [
          pot.announceTaskCall({
            treasury: T,
            what: WHAT2,
            payee: null,
            maxDollars: 2n * DOLLAR,
            shareBps: 100,
          }),
        ],
        CHAIN,
      );
      cap.taskOf1_announced = await raw(TASK_BOOK_ABI, B, "taskOf", [1n]);
      cap.taskOf2_announced = await raw(TASK_BOOK_ABI, B, "taskOf", [2n]);
      cap.openSerials2 = await raw(TASK_BOOK_ABI, B, "openSerials");
      expect(await reads.readOpenSerials(read, B)).toEqual([1n, 2n]);
      const t1 = (await reads.readTask(read, B, 1n))!;
      expect(t1).toMatchObject({
        what: WHAT1,
        payee: worker,
        state: "announced",
        shareBps: 250,
        takenBy: null,
        takenAt: null,
        deadline: null,
        maxDollars: 3n * DOLLAR,
        setAside: 0n,
      });
      const t2 = (await reads.readTask(read, B, 2n))!;
      expect(t2.payee).toBeNull();
      const notice = await reads.readNoticeFor(read, T, 250);
      expect(notice.noticeSecs).toBe(t1.noticeEnd - t1.announcedAt);
      expect(notice.takeWindowSecs).toBe(t1.expiresAt - t1.noticeEnd);

      await w[founder].sendCalls(
        [pot.cancelTaskCall({ treasury: T, serial: 2n })],
        CHAIN,
      );
      cap.taskOf2_cancelled = await raw(TASK_BOOK_ABI, B, "taskOf", [2n]);
      expect((await reads.readTask(read, B, 2n))!.state).toBe("cancelled");
      expect(await reads.readOpenSerials(read, B)).toEqual([1n]);

      // Too early to take: the contract says when (the notice is still running), and nothing moves.
      const early = await w[worker]
        .sendCalls(
          [
            pot.takeTaskCall({
              treasury: T,
              serial: 1n,
              minAmount: 1n * DOLLAR,
            }),
          ],
          CHAIN,
        )
        .then(
          () => null,
          (e) => e,
        );
      expect(early).toBeInstanceOf(WalletStepError);
      const refusalData = (
        (early as WalletStepError).cause as { data?: string } | undefined
      )?.data;
      const refusal = decodeRevert([TREASURY_ABI, TASK_BOOK_ABI], refusalData);
      expect(refusal?.name).toBe("NoticeRunning");
      expect(refusal?.args[0]).toBe(BigInt(t1.noticeEnd));

      // Take.
      await passTime(notice.noticeSecs + 5);
      await w[founder].sendCalls(
        [pot.checkInCall(T, `0x${"5b".repeat(32)}`)],
        CHAIN,
      );
      const room0 = await reads.readTakeRoom(read, B);
      cap.takeRoomBefore = await raw(TASK_BOOK_ABI, B, "takeRoomBps");
      await w[worker].sendCalls(
        [pot.takeTaskCall({ treasury: T, serial: 1n, minAmount: 1n * DOLLAR })],
        CHAIN,
      );
      cap.taskOf1_taken = await raw(TASK_BOOK_ABI, B, "taskOf", [1n]);
      const taken = (await reads.readTask(read, B, 1n))!;
      expect(taken.state).toBe("taken");
      expect(taken.takenBy).toBe(worker);
      expect(taken.takenAt).not.toBeNull();
      expect(taken.deadline).toBe((taken.takenAt as number) + notice.dueSecs);
      expect(taken.setAside).toBeGreaterThan(0n);
      expect(taken.setAside).toBeLessThanOrEqual(3n * DOLLAR);
      expect(taken.stayerClaim).toBe(taken.setAside);
      const room1 = await reads.readTakeRoom(read, B);
      expect(room1).toBeLessThan(room0);
      cap.takeRoomAfter = await raw(TASK_BOOK_ABI, B, "takeRoomBps");

      // Backer one takes out part: a note is written.
      const myShares = await reads.balanceOf(read, shares as string, backer1);
      const q = await reads.quoteTakeOut(read, T, backer1, myShares / 2n);
      expect(q.note).toBeGreaterThan(0n);
      const out = await planTakeOut(read, {
        treasury: T,
        holder: backer1,
        shares: myShares / 2n,
        to: backer1,
      });
      const fromBlock = await blockNumber();
      await w[backer1].sendCalls([out!.call], CHAIN);
      const note = await reads.readNoteOf(read, B, 1n, backer1);
      expect(note).toBeGreaterThan(0n);
      expect(note).toBe(q.note);
      cap.noteOf_backer1 = await raw(TASK_BOOK_ABI, B, "noteOf", [1n, backer1]);
      cap.noteOf_backer2 = await raw(TASK_BOOK_ABI, B, "noteOf", [1n, backer2]);
      cap.claimable_open = await raw(TASK_BOOK_ABI, B, "claimableNote", [
        1n,
        backer1,
      ]);
      expect(await reads.readClaimable(read, B, 1n, backer1)).toBe(0n);
      cap.taskOf1_takenWithNote = await raw(TASK_BOOK_ABI, B, "taskOf", [1n]);
      const withNote = (await reads.readTask(read, B, 1n))!;
      expect(withNote.noteFace).toBe(note);
      expect(withNote.stayerClaim + withNote.noteFace).toBe(withNote.setAside);

      // The note's log, as the node gives it, and the look-back finds it.
      const logs = await rpc<NoteLog[]>("eth_getLogs", [
        {
          address: B,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: "latest",
        },
      ]);
      cap.bookLogs = logs;
      const source = {
        getLogs: async (f: Parameters<MoneyWallet["getLogs"]>[0]) =>
          walletOf(backer1).getLogs(f),
        blockNumber,
      };
      const scanned = await reads.scanNotes(source, B, 0, backer1);
      expect(scanned).toEqual({ serials: [1n], reachedBlock: 0, done: true });
      const scannedOther = await reads.scanNotes(source, B, 0, stranger);
      expect(scannedOther).toEqual({
        serials: [],
        reachedBlock: 0,
        done: true,
      });
      cap.scanLogs = await walletOf(backer1).getLogs({
        address: B,
        topics: [null, null, `0x${backer1.slice(2).padStart(64, "0")}`],
        from: 0,
        to: await blockNumber(),
      });

      // Pay in part: the worker is paid, the rest comes back, the note is claimable for a share of it.
      const pay = withNote.setAside / 2n;
      const before = await reads.balanceOf(read, chain.dollar, worker);
      await w[founder].sendCalls(
        [pot.acceptTaskCall({ treasury: T, serial: 1n, payDollars: pay })],
        CHAIN,
      );
      expect(await reads.balanceOf(read, chain.dollar, worker)).toBe(
        before + pay,
      );
      cap.taskOf1_paid = await raw(TASK_BOOK_ABI, B, "taskOf", [1n]);
      const paid = (await reads.readTask(read, B, 1n))!;
      expect(paid.state).toBe("paid");
      expect(paid.returned).toBe(withNote.setAside - pay);
      cap.claimable_paid = await raw(TASK_BOOK_ABI, B, "claimableNote", [
        1n,
        backer1,
      ]);
      const claimable = await reads.readClaimable(read, B, 1n, backer1);
      expect(claimable).toBeGreaterThan(0n);
      expect(await reads.readTakeRoom(read, B)).toBeGreaterThanOrEqual(0);

      // Anyone may send a claim, but it pays the holder only.
      const hb = await reads.balanceOf(read, chain.dollar, backer1);
      const sb = await reads.balanceOf(read, chain.dollar, stranger);
      await w[stranger].sendCalls(
        [pot.claimNoteCall({ treasury: T, serial: 1n, holder: backer1 })],
        CHAIN,
      );
      expect(await reads.balanceOf(read, chain.dollar, backer1)).toBe(
        hb + claimable,
      );
      expect(await reads.balanceOf(read, chain.dollar, stranger)).toBe(sb);
      expect(await reads.readNoteOf(read, B, 1n, backer1)).toBe(0n);

      // A second task: taken, sent back; a third: taken and run out, returned by anyone.
      await w[founder].sendCalls(
        [pot.checkInCall(T, `0x${"5c".repeat(32)}`)],
        CHAIN,
      );
      await w[founder].sendCalls(
        [
          pot.announceTaskCall({
            treasury: T,
            what: `0x${"33".repeat(32)}`,
            payee: worker,
            maxDollars: 2n * DOLLAR,
            shareBps: 100,
          }),
        ],
        CHAIN,
      );
      const n3 = await reads.readNoticeFor(read, T, 100);
      await passTime(n3.noticeSecs + 5);
      await w[founder].sendCalls(
        [pot.checkInCall(T, `0x${"5d".repeat(32)}`)],
        CHAIN,
      );
      await w[worker].sendCalls(
        [pot.takeTaskCall({ treasury: T, serial: 3n, minAmount: 1n * DOLLAR })],
        CHAIN,
      );
      await w[founder].sendCalls(
        [pot.rejectTaskCall({ treasury: T, serial: 3n })],
        CHAIN,
      );
      cap.taskOf3_rejected = await raw(TASK_BOOK_ABI, B, "taskOf", [3n]);
      expect((await reads.readTask(read, B, 3n))!.state).toBe("rejected");

      await w[founder].sendCalls(
        [
          pot.announceTaskCall({
            treasury: T,
            what: `0x${"44".repeat(32)}`,
            payee: worker,
            maxDollars: 2n * DOLLAR,
            shareBps: 100,
          }),
        ],
        CHAIN,
      );
      await passTime(n3.noticeSecs + 5);
      await w[founder].sendCalls(
        [pot.checkInCall(T, `0x${"5e".repeat(32)}`)],
        CHAIN,
      );
      await w[worker].sendCalls(
        [pot.takeTaskCall({ treasury: T, serial: 4n, minAmount: 1n * DOLLAR })],
        CHAIN,
      );
      const early4 = await w[stranger]
        .sendCalls([pot.returnTaskCall({ treasury: T, serial: 4n })], CHAIN)
        .then(
          () => null,
          (e) => e,
        );
      expect(early4).not.toBeNull();
      await passTime(n3.dueSecs + 5);
      cap.taskOf4_overdue = await raw(TASK_BOOK_ABI, B, "taskOf", [4n]);
      const overdue = (await reads.readTask(read, B, 4n))!;
      expect(overdue.state).toBe("taken");
      await w[stranger].sendCalls(
        [pot.returnTaskCall({ treasury: T, serial: 4n })],
        CHAIN,
      );
      cap.taskOf4_returned = await raw(TASK_BOOK_ABI, B, "taskOf", [4n]);
      expect((await reads.readTask(read, B, 4n))!.state).toBe("returned");

      // A plan that nobody takes in its window: the take is refused, and nothing moves.
      await w[founder].sendCalls(
        [pot.checkInCall(T, `0x${"5f".repeat(32)}`)],
        CHAIN,
      );
      await w[founder].sendCalls(
        [
          pot.announceTaskCall({
            treasury: T,
            what: `0x${"55".repeat(32)}`,
            payee: worker,
            maxDollars: 2n * DOLLAR,
            shareBps: 100,
          }),
        ],
        CHAIN,
      );
      await passTime(n3.noticeSecs + n3.takeWindowSecs + 5);
      // Nobody checked in for the whole notice and window, so the take is refused in the Treasury's own words about the check-in.
      const lapsed = await w[worker]
        .sendCalls(
          [
            pot.takeTaskCall({
              treasury: T,
              serial: 5n,
              minAmount: 1n * DOLLAR,
            }),
          ],
          CHAIN,
        )
        .then(
          () => null,
          (e) => e,
        );
      expect(lapsed).toBeInstanceOf(WalletStepError);
      expect(potProblem(lapsed, "take-out")).toBe(
        "The team has not checked in lately, so no task can be planned or taken until they do. Nothing changed.",
      );
      if (OUT)
        writeFileSync(
          OUT,
          JSON.stringify(
            cap,
            (_, v) => (typeof v === "bigint" ? `${v}n` : v),
            2,
          ),
        );
    });
  },
);
