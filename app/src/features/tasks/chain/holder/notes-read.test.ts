// Which tasks a person may be owed money on, and the figure of a claim: pure rules over the example's rows.
import { describe, expect, it } from "vitest";
import {
  ENDED_SERIAL,
  RUNNING_SERIAL,
  CLAIMANT,
  STAYER,
} from "../../../../../tests/helpers/notes-scene";
import { queueOf, sceneNumbers } from "../../../../../tests/helpers/plan-scene";
import type { ChainTaskNow } from "../types";
import { claimFigure } from "./claim-read";
import { MOST_CANDIDATES, noteCandidates } from "./notes-read";

const queue = queueOf(sceneNumbers());
const big = (serial: number) => BigInt(serial);

describe("which tasks to look at", () => {
  it("lists the rows that name the account among the holders of claims, and every taken row", () => {
    const mine = noteCandidates({
      queue,
      account: CLAIMANT,
      own: [],
      found: [],
    });
    expect(mine).toContain(big(ENDED_SERIAL));
    // A taken task is always a candidate (a claim on a running task); the network says whether this account holds one.
    expect(mine).toContain(big(RUNNING_SERIAL));
    const stayer = noteCandidates({
      queue,
      account: STAYER,
      own: [],
      found: [],
    });
    expect(stayer).toContain(big(RUNNING_SERIAL));
  });

  it("includes every ended row with money still to claim, whoever it lists: the record's list of holders may be cut", () => {
    const ended = queue.list.filter(
      (r) => r.state !== "announced" && r.state !== "taken" && r.notesLeft > 0n,
    );
    expect(ended.length).toBeGreaterThan(0);
    const stranger = noteCandidates({
      queue,
      account: "0x00000000000000000000000000000000000000ab",
      own: [],
      found: [],
    });
    for (const row of ended) expect(stranger).toContain(row.serial);
    // A plan nobody took, and a row that ended with nothing left to claim, are not candidates.
    for (const row of queue.list.filter(
      (r) =>
        r.state === "announced" || (r.state !== "taken" && r.notesLeft === 0n),
    ))
      expect(stranger).not.toContain(row.serial);
  });

  it("lists a row that names the account among the holders of claims, even when it is ended with nothing left to claim", () => {
    const ended = queue.list.find((r) => r.serial === BigInt(ENDED_SERIAL));
    if (!ended) throw new Error("no ended row");
    const row = { ...ended, serial: 777n, notesLeft: 0n };
    const only = { ...queue, list: [row] };
    expect(
      noteCandidates({ queue: only, account: CLAIMANT, own: [], found: [] }),
    ).toEqual([777n]);
    expect(
      noteCandidates({ queue: only, account: STAYER, own: [], found: [] }),
    ).toEqual([]);
  });

  it("adds what this browser remembers and what a look back found, each once, newest first", () => {
    const got = noteCandidates({
      queue: null,
      account: CLAIMANT,
      own: [3n, 900n],
      found: [900n, 12n],
    });
    expect(got).toEqual([900n, 12n, 3n]);
  });

  it("is at most 40", () => {
    const own = Array.from({ length: 60 }, (_, i) => BigInt(1000 + i));
    const got = noteCandidates({ queue, account: CLAIMANT, own, found: [] });
    expect(got).toHaveLength(MOST_CANDIDATES);
    expect(got[0]).toBe(1059n);
  });
});

describe("what a claim pays", () => {
  const row = queue.list.find((r) => r.serial === BigInt(ENDED_SERIAL));
  if (!row) throw new Error("no ended row");
  const ended = (over: Partial<ChainTaskNow> = {}): ChainTaskNow => ({
    ...row,
    ...over,
  });
  const face = row.notes?.holders[0]?.face ?? 0n;
  const view = row.notes?.holders[0]?.claimable ?? 0n;
  const after = row.resolvedAt ?? 0;

  it("is the network's own figure for a task that ended, when it is the contract's rounding of the claim", () => {
    const figure = claimFigure({ task: ended(), face, view }, after + 1);
    expect(figure).toEqual({ claimable: view, overdue: false, block: null });
    expect(view).toBe((face * row.returned) / row.setAside);
  });

  it("is nothing for a claim that is gone, and for a task paid in full", () => {
    expect(
      claimFigure({ task: ended(), face: 0n, view: 0n }, after + 1).block,
    ).toMatch(/nothing to claim here/);
    const paidInFull = ended({ state: "paid", returned: 0n });
    expect(
      claimFigure({ task: paidInFull, face, view: 0n }, after + 1).block,
    ).toMatch(/paid in full, or you already claimed/);
  });

  it("is nothing for a claim too small to pay anything: the contract would clear it for no money, so no press", () => {
    const small = ended({ setAside: row.setAside * 10n });
    const figure = claimFigure({ task: small, face: 1n, view: 0n }, after + 1);
    expect(figure.claimable).toBe(0n);
    expect(figure.block).toMatch(/nothing to claim here/);
  });

  it("is not payable while the task is running, and says when it ends", () => {
    const running = queue.list.find((r) => r.serial === BigInt(RUNNING_SERIAL));
    if (!running) throw new Error("no running row");
    const figure = claimFigure(
      { task: running, face: 5n, view: 0n },
      (running.deadline ?? 0) - 1,
    );
    expect(figure.claimable).toBe(0n);
    expect(figure.block).toMatch(
      /has not ended yet, so there is nothing to claim/,
    );
  });

  it("is the whole claim for a task that ran out and nobody settled, though the network's view reads zero", () => {
    const running = queue.list.find((r) => r.serial === BigInt(RUNNING_SERIAL));
    if (!running) throw new Error("no running row");
    const figure = claimFigure(
      { task: running, face: 5n, view: 0n },
      (running.deadline ?? 0) + 1,
    );
    expect(figure).toEqual({ claimable: 5n, overdue: true, block: null });
  });

  it("is refused when the network's view is not what the contract's rounding gives: nothing is acted on", () => {
    const figure = claimFigure(
      { task: ended(), face, view: view + 1n },
      after + 1,
    );
    expect(figure.claimable).toBe(0n);
    expect(figure.block).toMatch(/did not add up/);
  });
});
