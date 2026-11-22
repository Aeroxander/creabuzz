/**
 * The vote and the Council as the screens read them: the phase at the moment shown, the times, whether this person may
 * vote or stand (the chain's weight, never a guess), the two alerts' inputs, and the Council's seats and waiting counts.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  alertsOf,
  canStand,
  canVote,
  isLive,
  phaseAt,
  timesOf,
  useVote,
} from "./use-vote";
import {
  councilStateOf,
  isSeatHolder,
  runnerKindOf,
  seatOf,
  seatsDue,
  useCouncil,
  waitingOf,
} from "./use-council";
import {
  ACCOUNTS,
  councilPlain,
  councilRecord,
  NOW,
  type BallotCase,
} from "../../../tests/helpers/council-v2-parse";

const vote = (testCase: BallotCase) => councilRecord(testCase).vote!;
const councilOf = (testCase: BallotCase) => councilRecord(testCase).council!;

describe("the vote: where it stands, and when", () => {
  it("every phase follows the record's own times", () => {
    const phases: Array<[BallotCase, string]> = [
      ["standing", "standing"],
      ["voting", "voting"],
      ["moved", "waiting"],
      ["counting", "counting"],
      ["carried-out", "carried-out"],
      ["lapsed", "lapsed"],
      ["kept", "ended"],
      ["short", "ended"],
      ["seated", "waiting"],
      ["unchanged", "ended"],
    ];
    for (const [testCase, phase] of phases)
      expect(phaseAt(vote(testCase), NOW), testCase).toBe(phase);
    // Before the names are final and while the vote runs, it is live.
    expect(isLive(vote("standing"), NOW)).toBe(true);
    expect(isLive(vote("voting"), NOW)).toBe(true);
    expect(isLive(vote("waiting"), NOW)).toBe(false);
  });

  it("the times and the next openings come from the record", () => {
    const v = vote("voting");
    const times = timesOf(v);
    expect(times.voteStartsAt).toBe(v.open?.standEnd);
    expect(times.voteEndsAt).toBe(v.open?.voteEnd);
    expect(times.takesEffectAt).toBe(v.open?.effectiveAt);
    expect(times.replaceFrom).toBe(NOW);
    expect(times.openFloor).toBe(50_000n * 10n ** 18n);
    expect(times.seatsAt).toBe(councilOf("voting").nextElection);
  });
});

describe("the vote: who may vote, and what the app cannot know", () => {
  it("the chain's weight decides; without it the app says it cannot know", () => {
    const v = vote("voting");
    expect(canVote({ vote: v, now: NOW, weight: 1n })).toBe(true);
    expect(canVote({ vote: v, now: NOW, weight: 0n })).toBe(false);
    expect(canVote({ vote: v, now: NOW })).toBeNull();
    // A parked hint is only a hint: Shares parked after the ballot opened do not count.
    expect(canVote({ vote: v, now: NOW, parked: 5n })).toBe(true);
    // A vote that is not live allows no vote whatever the weight.
    expect(canVote({ vote: vote("waiting"), now: NOW, weight: 5n })).toBe(
      false,
    );
  });

  it("standing needs the rule's thousandth of the snapshot, and the stand window", () => {
    const v = vote("standing");
    const supply = v.open!.supply;
    const needs = (supply + 999n) / 1000n;
    expect(canStand({ vote: v, now: NOW, weight: needs })).toBe(true);
    expect(canStand({ vote: v, now: NOW, weight: needs - 1n })).toBe(false);
    expect(canStand({ vote: v, now: NOW })).toBeNull();
    // After the names are final nobody may stand.
    expect(canStand({ vote: vote("voting"), now: NOW, weight: supply })).toBe(
      false,
    );
  });
});

describe("the two alerts' inputs (6.7)", () => {
  it("a vote alert while a ballot is live, ending when it ends", () => {
    const alerts = alertsOf(vote("voting"), NOW);
    expect(alerts.open).toEqual({
      kind: "replace",
      endsAt: vote("voting").open?.voteEnd,
    });
    expect(alerts.moved).toBeNull();
    // A standing ballot is live too.
    expect(alertsOf(vote("standing"), NOW).open).not.toBeNull();
  });

  it("a moved alert from voteEnd on, even when nobody recorded the result, until it takes effect", () => {
    const v = vote("moved");
    expect(v.open?.result?.recorded).toBe(false);
    const alerts = alertsOf(v, NOW);
    expect(alerts.open).toBeNull();
    expect(alerts.moved).toEqual({
      outcome: "moved",
      effectiveAt: v.open?.effectiveAt,
      id: v.open?.id,
    });
    // Once it has taken effect, the alert is over.
    expect(alertsOf(v, (v.open?.effectiveAt ?? 0) + 1).moved).toBeNull();
    // A seat result is a move too.
    expect(alertsOf(vote("seated"), NOW).moved?.outcome).toBe("seated");
    // A result that changes nothing makes no alert.
    expect(alertsOf(vote("kept"), NOW).moved).toBeNull();
  });
});

describe("the hooks read a record, and a record older than its promise says so", () => {
  it("useVote exposes the vote, its phase, its times and both alerts", () => {
    const numbers = councilRecord("moved");
    const { result } = renderHook(() =>
      useVote({ numbers, now: NOW, weight: 3n }),
    );
    expect(result.current?.open?.kind).toBe("replace");
    expect(result.current?.phase).toBe("waiting");
    expect(result.current?.times?.takesEffectAt).toBe(
      result.current?.open?.effectiveAt,
    );
    expect(result.current?.alerts.moved).not.toBeNull();
    expect(result.current?.canVote).toBe(false);
  });

  it("useVote says a record is old when it is older than its own promise", () => {
    const numbers = councilRecord("voting");
    const { result } = renderHook(() =>
      useVote({ numbers, now: numbers.builtAt + 25 * 60 * 60 }),
    );
    expect(result.current?.old).toBe(true);
    const fresh = renderHook(() => useVote({ numbers, now: NOW }));
    expect(fresh.result.current?.old).toBe(false);
  });

  it("a project with no vote has none to show", () => {
    const { result } = renderHook(() =>
      useVote({ numbers: councilPlain(), now: NOW }),
    );
    expect(result.current?.vote).toBeNull();
    expect(result.current?.alerts).toEqual({ open: null, moved: null });
  });
});

describe("the Council: the section's state, seats and waiting actions", () => {
  it("a project with no Council shows nothing; a Council that did not read says so", () => {
    expect(councilStateOf(councilPlain())).toEqual({ kind: "none" });
    const unreadable = councilRecord("voting", (r) => {
      r.council = { ...r.council, needed: 0 };
    });
    expect(councilStateOf(unreadable)).toEqual({ kind: "unreadable" });
    expect(councilStateOf(councilRecord("voting")).kind).toBe("council");
  });

  it("the seats, the holder's own seat, the threshold and the next election", () => {
    const c = councilOf("voting");
    expect(seatOf(c, ACCOUNTS[0] as string)?.index).toBe(0);
    expect(seatOf(c, "0x0000000000000000000000000000000000000009")).toBeNull();
    expect(seatOf(c, null)).toBeNull();
    expect(isSeatHolder(c, ACCOUNTS[4] as string)).toBe(true);
    expect(isSeatHolder(c, "0x0000000000000000000000000000000000000009")).toBe(
      false,
    );
    expect(waitingOf(c)?.count).toBe(1);
    expect(seatsDue(c, NOW)).toBe(false);
    expect(seatsDue(c, c.nextElection)).toBe(true);
  });

  it("useCouncil exposes the runner kind, the seats and who may propose", () => {
    const numbers = councilRecord("voting");
    const { result } = renderHook(() =>
      useCouncil({ numbers, address: ACCOUNTS[2] as string, now: NOW }),
    );
    expect(result.current?.runnerKind).toBe("council");
    expect(result.current?.seats).toHaveLength(5);
    expect(result.current?.needed).toBe(3);
    expect(result.current?.isSeat).toBe(true);
    expect(result.current?.mySeat?.index).toBe(2);
    expect(result.current?.waiting?.count).toBe(1);
    expect(result.current?.electionDue).toBe(false);
    // A person who is not a seat holder sees the seats and no proposals.
    const visitor = renderHook(() =>
      useCouncil({ numbers, address: null, now: NOW }),
    );
    expect(visitor.result.current?.isSeat).toBe(false);
    expect(visitor.result.current?.seats).toHaveLength(5);
  });

  it("a record signed before the runner kind existed still reads as a Pair or a founder", () => {
    const plain = councilPlain();
    expect(runnerKindOf(plain)).toBe("single");
    expect(
      runnerKindOf({ ...plain, runner: { ...plain.runner, isPair: true } }),
    ).toBe("pair");
  });
});
