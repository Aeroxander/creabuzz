// The record's own vote as news (COUNCIL-PLAN.md 6.7): a ballot live now is `vote` news, urgent until it ends, and a
// frozen result that moves the runner or the seats is `moved` news, urgent until it takes effect. No event and no server
// write: both come from the record's `step.vote`, read strictly, and a key that cannot be believed says nothing.
import { describe, expect, it } from "vitest";
import { BACKER_EVM } from "../../../tests/helpers/pot-harness";
import {
  councilPlain,
  councilRecord,
} from "../../../tests/helpers/council-v2-parse";
import type { ProjectNumbers } from "../money/numbers";
import { type AlertsInput, alertsOf, alertsResult } from "./alerts";
import { movedWords, voteOpenWords } from "./alert-words";

const DAY = 86_400;

function input(
  numbers: ProjectNumbers,
  over: Partial<AlertsInput> = {},
): AlertsInput {
  return {
    numbers: [numbers],
    names: new Map([[numbers.key, "Lantern"]]),
    me: [BACKER_EVM],
    held: () => true,
    tasksOf: () => undefined,
    now: numbers.asOf.time,
    ...over,
  };
}

// --- A vote and a result that moves who runs the project (COUNCIL-PLAN.md 6.7) ---------------------------------------

describe("the vote's news, and the change it makes", () => {
  const live = (numbers: ProjectNumbers) =>
    alertsOf(input(numbers)).find((a) => a.kind === "vote");

  it("a ballot open now is vote news, urgent until it ends, at the record's own times, under its own id", () => {
    const numbers = councilRecord("voting");
    const open = numbers.vote?.open;
    expect(open).not.toBeNull();
    const alert = live(numbers);
    expect(alert).toBeDefined();
    expect(alert?.urgent).toBe(true);
    expect(alert?.before).toBe(open?.voteEnd);
    expect(alert?.at).toBe(open?.openedAt);
    expect(alert?.said).toBe(voteOpenWords(open?.voteEnd ?? 0));
    expect(alert?.words).toBe(`Lantern: ${alert?.said}`);
    expect(alert?.id).toBe(`${numbers.key}:vote:${open?.id}`);
    expect(alert?.serial).toBe(0n);
  });

  it("a ballot still taking names is vote news too, and either kind makes one", () => {
    expect(live(councilRecord("standing"))?.urgent).toBe(true);
    expect(live(councilRecord("seats-standing"))?.kind).toBe("vote");
    expect(live(councilRecord("seats"))?.kind).toBe("vote");
  });

  it("a result that moves the runner is moved news from the vote's end, urgent until it takes effect", () => {
    const numbers = councilRecord("moved");
    const open = numbers.vote?.open;
    const alert = alertsOf(input(numbers)).find((a) => a.kind === "moved");
    expect(alert?.urgent).toBe(true);
    expect(alert?.before).toBe(open?.effectiveAt);
    expect(alert?.at).toBe(open?.voteEnd);
    expect(alert?.said).toBe(
      movedWords({ effectiveAt: open?.effectiveAt ?? 0, seated: false }),
    );
    // The id names the ballot, so a changed state is unseen again while an unchanged one is not.
    expect(alert?.id).toBe(`${numbers.key}:moved:${open?.id}`);
    expect(live(numbers)).toBeUndefined();
    expect(alert?.id).not.toBe(`${numbers.key}:vote:${open?.id}`);
  });

  it("a seat election's result says the seats change, not that a new Council takes over", () => {
    const numbers = councilRecord("seated");
    const open = numbers.vote?.open;
    const alert = alertsOf(input(numbers)).find((a) => a.kind === "moved");
    expect(alert?.said).toBe(
      movedWords({ effectiveAt: open?.effectiveAt ?? 0, seated: true }),
    );
    expect(alert?.said).toContain("the elected accounts take their seats");
  });

  it("no moved news once it took effect, or for a result that changed nothing", () => {
    for (const testCase of [
      "carried-out",
      "kept",
      "short",
      "unchanged",
    ] as const)
      expect(
        alertsOf(input(councilRecord(testCase))).filter(
          (a) => a.kind === "moved" || a.kind === "vote",
        ),
      ).toEqual([]);
  });

  it("a project with no vote gives no vote news, and the task news stands", () => {
    expect(
      alertsOf(input(councilPlain())).filter(
        (a) => a.kind === "vote" || a.kind === "moved",
      ),
    ).toEqual([]);
    expect(alertsOf(input(councilRecord("voting"))).length).toBeGreaterThan(1);
  });

  it("a vote key that cannot be believed gives no vote news, and the record's task news still stands", () => {
    const hostile = councilRecord("voting", (r) => {
      r.vote.open.voteEnd = "soon";
    });
    const alerts = alertsOf(input(hostile));
    expect(alerts.filter((a) => a.kind === "vote")).toEqual([]);
    expect(alerts.some((a) => a.kind === "planned")).toBe(true);
  });

  it("a project the person does not hold gives no vote news, and one whose holding is unknown is asked about", () => {
    const numbers = councilRecord("voting", (r) => {
      delete r.tasks;
    });
    expect(numbers.tasks).toBeUndefined();
    expect(alertsOf(input(numbers, { held: () => false }))).toEqual([]);
    const unknown = alertsResult(input(numbers, { held: () => "unknown" }));
    expect(unknown.alerts).toEqual([]);
    expect(unknown.unknownHeld).toEqual([numbers.key]);
    // With the holding known, the vote's news shows.
    expect(
      alertsOf(input(numbers, { held: () => true })).map((a) => a.kind),
    ).toEqual(["vote"]);
  });

  it("the sentence follows the record's own clock: a vote that has ended gives no vote news", () => {
    const numbers = councilRecord("voting");
    const later = numbers.asOf.time + 40 * DAY;
    expect(
      alertsOf(input(numbers, { now: later })).filter(
        (a) => a.kind === "vote" || a.kind === "moved",
      ),
    ).toEqual([]);
  });
});
