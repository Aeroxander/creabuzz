// Mutates the numbers of the example's `tasks` section inside what the parser accepts (times 0 or 2^40, amounts 0 or 2^128-1,
// shares 0 or 65535, a zero pot) and runs every pure function a holder screen calls on the parsed queue, with a fixed seed. A throw
// would blank the page or the Money tab (the app has no error boundary), and Take out lives there.
import { describe, expect, it } from "vitest";
import { numbersFor } from "../../../../../tests/helpers/pot-harness";
import { withTasks } from "../../../../../tests/helpers/numbers-v2-fixture";
import { plannedBackLine } from "../../../pot/back-tasks";
import { claimableNow, nowOf, phaseOf, stateWords } from "../state";
import { atMostNowLine, endedLine, plannedLines } from "../words";
import { claimFigure } from "./claim-read";
import { claimLine, claimHeadline } from "./notes-words";
import { noteCandidates } from "./notes-read";
import { setAsideAndRoom } from "./holder-words";
import { stripRows } from "./PlannedStrips";
import { takeBlock } from "./take-gate";

type Json = Record<string, unknown>;
let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const TIMES = [0, 1, 2 ** 40, 2 ** 31, 1803787880];
const AMOUNTS = ["0", "1", "999999", "340282366920938463463374607431768211455"];
const SHARES = [0, 1, 500, 65535];

function mutate(tasks: Json) {
  const rows = tasks.list as Json[];
  for (const row of rows)
    for (const [k, v] of Object.entries(row)) {
      if (rnd() >= 0.03) continue;
      if (typeof v === "string" && /^\d+$/.test(v) && k !== "what")
        row[k] = pick(AMOUNTS);
      else if (typeof v === "number" && /At$|End$|deadline/.test(k))
        row[k] = pick(TIMES);
      else if (typeof v === "number" && /Bps$/.test(k)) row[k] = pick(SHARES);
    }
}

describe("parser-valid extremes never throw in the holder functions", () => {
  it("runs 1500 mutated records", () => {
    let parsed = 0;
    const kinds: Record<string, number> = {};
    for (let n = 0; n < 1500; n += 1) {
      const numbers = numbersFor((content) => {
        withTasks((tasks, c) => {
          mutate(tasks);
          if (rnd() < 0.3) (c.money as Json).pot = pick(AMOUNTS);
        })(content);
      });
      if (typeof numbers.tasks !== "object" || numbers.tasks === null) {
        kinds[String(numbers.tasks)] = (kinds[String(numbers.tasks)] ?? 0) + 1;
        continue;
      }
      parsed += 1;
      const queue = numbers.tasks;
      const now = pick([nowOf(numbers.asOf.time), 0, 2 ** 40]);
      plannedBackLine(numbers);
      stripRows(queue, now, null);
      noteCandidates({
        queue,
        account: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
        own: [],
        found: [],
      });
      setAsideAndRoom({
        locked: numbers.money.locked,
        roomBps: queue.cap.roomBps,
        backAt: null,
      });
      for (const row of queue.list) {
        const phase = phaseOf(row, now, null);
        stateWords(row, now);
        plannedLines({
          max: row.maxDollars,
          name: null,
          what: null,
          date: row.noticeEnd,
          open: false,
        });
        if (row.atMostNow !== null) atMostNowLine(row.atMostNow);
        endedLine({ task: row, phase, name: null, what: null });
        claimableNow(row, 123456n, now);
        claimFigure({ task: row, face: 123456n, view: 0n }, now);
        claimLine({ phase, face: 5n, claimable: 5n, paidInFull: false });
        claimHeadline({ what: null, setAside: row.setAside, running: false });
        takeBlock({
          read: {
            task: row,
            book: "0x",
            time: now,
            activeEnd: now + 10,
            roomBps: pick(SHARES),
          } as never,
          numbers,
          queue,
          address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
          now,
        });
      }
    }
    expect(JSON.stringify({ parsed, kinds })).toMatch(/parsed":([6-9]|\d\d+)/);
  });
});
