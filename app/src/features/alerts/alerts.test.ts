// The news derived from the signed record: every kind and phase, the id that follows the state, the team's words only where
// they tie, a week later, an old record, the three-ended cap and a hostile name. Every number is read from the parsed example
// (never copied) and a row is changed through `withTasks`.
import { describe, expect, it } from "vitest";
import {
  BACKER_EVM,
  numbersFor,
  STRANGER_EVM,
} from "../../../tests/helpers/pot-harness";
import {
  PLANNED_SERIAL,
  planTask,
  plannedNumbers,
  plannedRowOf,
  queueOf,
  sceneNumbers,
  TASK_ID,
  TAKEN_SERIAL,
  takenNumbers,
  takenRowOf,
  WORKER_WALLET,
} from "../../../tests/helpers/plan-scene";
import { taskRow, withTasks } from "../../../tests/helpers/numbers-v2-fixture";
import { dayText, timeText, type ProjectNumbers } from "../money/numbers";
import { dollarsPhrase } from "../tasks/chain/words";
import type { ChainTask } from "../tasks/chain/types";
import {
  type AlertsInput,
  alertsOf,
  alertsResult,
  MOST_ENDED_PER_PROJECT,
  type TaskAlert,
} from "./alerts";

const DAY = 86_400;
/** The account the example lists as owed money on its ran-out task. */
const OWED = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

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

const rowsOf = (numbers: ProjectNumbers, state: ChainTask["state"]) =>
  queueOf(numbers).list.filter((r) => r.state === state);
const ids = (alerts: readonly TaskAlert[]) => alerts.map((a) => a.id);
const find = (alerts: readonly TaskAlert[], kind: string, serial: bigint) =>
  alerts.find((a) => a.kind === kind && a.serial === serial);

describe("every kind of news and every phase of a row", () => {
  const numbers = sceneNumbers();
  const alerts = alertsOf(input(numbers));

  it("a plan nobody has taken is planned news, urgent while its notice runs, with the date money can first move", () => {
    const plans = rowsOf(numbers, "announced");
    expect(plans.length).toBeGreaterThan(0);
    for (const row of plans) {
      const alert = find(alerts, "planned", row.serial);
      expect(alert, `plan ${row.serial}`).toBeDefined();
      expect(alert?.at).toBe(row.announcedAt);
      expect(alert?.urgent).toBe(true);
      expect(alert?.before).toBe(row.noticeEnd);
      expect(alert?.said).toContain(`from ${timeText(row.noticeEnd)}`);
      expect(alert?.said).toContain("You can take your money out before then.");
      expect(alert?.words).toBe(`Lantern: ${alert?.said}`);
    }
  });

  it("a plan whose notice is over can be taken and is not urgent: it says until when, and that leaving works any time", () => {
    const open = sceneNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        PLANNED_SERIAL,
      );
      row.noticeEnd = (content.asOf as { time: number }).time - 60;
    });
    const row = plannedRowOf(open);
    const alert = find(alertsOf(input(open)), "planned", row.serial);
    expect(alert?.urgent).toBe(false);
    expect(alert?.before).toBeNull();
    expect(alert?.said).toContain(
      `It can be taken until ${timeText(row.expiresAt)}.`,
    );
    expect(alert?.said).toContain("You can take your money out any time.");
  });

  it("a task somebody took is taken news with what is set aside and until when", () => {
    const row = takenRowOf(takenNumbers());
    const alert = find(alerts, "taken", BigInt(TAKEN_SERIAL));
    expect(alert).toBeDefined();
    expect(alert?.at).toBe(row.takenAt ?? row.announcedAt);
    expect(alert?.said).toContain("was taken.");
    expect(alert?.said).toContain(`until ${timeText(row.deadline ?? 0)}.`);
  });

  it("a taken task past its deadline that nobody settled reads as ran out, as news of its own", () => {
    const late = sceneNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        TAKEN_SERIAL,
      );
      const past = (content.asOf as { time: number }).time - 10;
      row.deadline = past;
      row.expiresAt = past;
    });
    const alert = find(alertsOf(input(late)), "ran-out", BigInt(TAKEN_SERIAL));
    expect(alert?.said).toContain(
      "ran out. The money goes back to the project.",
    );
    expect(alert?.id).toBe(`${late.key}:${TAKEN_SERIAL}:ran-out`);
  });

  it("tasks that ended and moved money are ended news: paid in part, sent back, ran out", () => {
    for (const row of queueOf(numbers).list) {
      const alert = find(alerts, "ended", row.serial);
      if (row.state === "paid") {
        expect(alert?.said).toContain(
          `of the ${dollarsPhrase(row.setAside)} set aside; the rest went back.`,
        );
        expect(row.pay).toBeLessThan(row.setAside);
      } else if (row.state === "rejected" || row.state === "returned")
        expect(alert?.said).toContain(
          "ended and nothing was paid. The money went back to the project.",
        );
    }
    expect(rowsOf(numbers, "paid").length).toBe(1);
  });

  it("a task paid in full says it was paid", () => {
    const full = sceneNumbers((content) => {
      const paid = rowsOf(numbers, "paid")[0] as ChainTask;
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        Number(paid.serial),
      );
      row.pay = row.setAside;
      row.returned = "0";
    });
    const paid = rowsOf(full, "paid")[0] as ChainTask;
    const alert = find(alertsOf(input(full)), "ended", paid.serial);
    expect(alert?.said).toMatch(/was paid [\d,.]+ dollars?\.$/);
    expect(alert?.said).not.toContain("set aside");
  });

  it("a plan that was withdrawn or lapsed moved nothing, so it makes none", () => {
    const quiet = [
      ...rowsOf(numbers, "cancelled"),
      ...rowsOf(numbers, "lapsed"),
    ];
    expect(quiet.length).toBeGreaterThan(0);
    for (const row of quiet)
      expect(alerts.filter((a) => a.serial === row.serial)).toEqual([]);
  });

  it("a plan nobody took in time (its window is over, the network has not marked it) makes none", () => {
    const missed = sceneNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        PLANNED_SERIAL,
      );
      row.noticeEnd = (content.asOf as { time: number }).time - 100;
      row.expiresAt = (content.asOf as { time: number }).time - 5;
    });
    expect(
      alertsOf(input(missed)).filter(
        (a) => a.serial === BigInt(PLANNED_SERIAL),
      ),
    ).toEqual([]);
  });

  it("a task swept by the wind-down that held money is ended news; one that held none makes none", () => {
    const swept = sceneNumbers((content) => {
      const at = (content.asOf as { time: number }).time - 100;
      content.windDown = { at, kind: 1 };
      content.quiet = {
        ...(content.quiet as object),
        state: "wound_down",
        next: null,
      };
      const closed = rowsOf(numbers, "returned")[0] as ChainTask;
      taskRow(
        content.tasks as Record<string, unknown>,
        Number(closed.serial),
      ).resolvedAt = at;
      const cancelled = rowsOf(numbers, "cancelled")[0] as ChainTask;
      taskRow(
        content.tasks as Record<string, unknown>,
        Number(cancelled.serial),
      ).resolvedAt = at;
    });
    const got = alertsOf(input(swept));
    const closed = rowsOf(swept, "returned")[0] as ChainTask;
    const cancelled = rowsOf(swept, "cancelled")[0] as ChainTask;
    expect(find(got, "ended", closed.serial)).toBeDefined();
    expect(find(got, "ended", cancelled.serial)).toBeUndefined();
  });

  it("a person the record lists as owed money gets a claim, even holding nothing", () => {
    const claim = alertsOf(input(numbers, { me: [OWED], held: () => false }));
    const row = rowsOf(numbers, "returned")[0] as ChainTask;
    const alert = find(claim, "claim", row.serial);
    expect(claim.map((a) => a.kind)).toEqual(["claim"]);
    expect(alert?.said).toContain(
      `you can claim ${(row.notes?.holders[0]?.claimable ?? 0n) / 1_000_000n}`,
    );
    expect(alert?.said).toContain("It ended after you took out.");
  });

  it("a person owed nothing (a claim of zero) gets no claim", () => {
    expect(
      find(
        alertsOf(input(numbers, { me: [BACKER_EVM], held: () => false })),
        "claim",
        BigInt(TAKEN_SERIAL),
      ),
    ).toBeUndefined();
  });

  it("each person is told what is theirs: two accounts see the claims of both", () => {
    const two = alertsOf(
      input(numbers, { me: [BACKER_EVM, OWED.toUpperCase()] }),
    );
    expect(two.some((a) => a.kind === "claim")).toBe(true);
  });
});

describe("order, ids and the cap on ended news", () => {
  const numbers = sceneNumbers();

  it("planned and taken first, then claims, then ended, each newest first", () => {
    const alerts = alertsOf(input(numbers, { me: [OWED] }));
    const order = alerts.map((a) => a.kind);
    const lastLive = Math.max(
      order.lastIndexOf("planned"),
      order.lastIndexOf("taken"),
    );
    expect(lastLive).toBeLessThan(order.indexOf("claim"));
    expect(order.lastIndexOf("claim")).toBeLessThan(order.indexOf("ended"));
    const times = alerts.filter((a) => a.kind === "ended").map((a) => a.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // A plan still in its notice comes before any other news, the one whose notice ends soonest first.
    const urgent = alerts.filter((a) => a.urgent);
    expect(urgent.length).toBeGreaterThan(1);
    expect(alerts.slice(0, urgent.length)).toEqual(urgent);
    const ends = urgent.map((a) => a.before ?? 0);
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
  });

  it("an id is the project, the serial and the kind, so a changed state is a new id", () => {
    const before = alertsOf(input(numbers));
    const taken = sceneNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        PLANNED_SERIAL,
      );
      const at = (content.asOf as { time: number }).time;
      row.state = "taken";
      row.takenBy = WORKER_WALLET;
      row.payee = WORKER_WALLET;
      row.takenAt = at - 60;
      row.deadline = at + DAY;
      row.setAside = "1000000";
    });
    const after = alertsOf(input(taken));
    const planned = `${numbers.key}:${PLANNED_SERIAL}:planned`;
    expect(ids(before)).toContain(planned);
    expect(ids(after)).not.toContain(planned);
    expect(ids(after)).toContain(`${numbers.key}:${PLANNED_SERIAL}:taken`);
    expect(new Set(ids(before)).size).toBe(before.length);
  });

  it("at most three ended alerts per project, the rest counted, so a flood of cheap tasks cannot push a notice off", () => {
    const flood = sceneNumbers((content) => {
      const tasks = content.tasks as Record<string, unknown>;
      const list = tasks.list as Record<string, unknown>[];
      const sample = taskRow(
        tasks,
        Number(rowsOf(numbers, "rejected")[0]?.serial),
      );
      for (let i = 0; i < 6; i += 1)
        list.push({
          ...structuredClone(sample),
          serial: 40 + i,
          what: `0x${(i + 1).toString(16).padStart(64, "0")}`,
        });
      tasks.nextSerial = 100;
    });
    const result = alertsResult(input(flood));
    const ended = result.alerts.filter((a) => a.kind === "ended");
    expect(ended).toHaveLength(MOST_ENDED_PER_PROJECT);
    const total = queueOf(flood).list.filter(
      (r) =>
        r.state === "rejected" || r.state === "returned" || r.state === "paid",
    ).length;
    expect(result.moreEnded).toEqual([
      {
        chainKey: flood.key,
        projectName: "Lantern",
        count: total - MOST_ENDED_PER_PROJECT,
      },
    ]);
    // The planned and taken notices are still first.
    const live = result.alerts.filter((a) => a.kind !== "ended").length;
    expect(result.alerts.slice(0, live).every((a) => a.kind !== "ended")).toBe(
      true,
    );
    expect(live).toBeGreaterThan(0);
  });

  it("news about a task that ended before the record's own window is left to the Tasks tab, a claim on it is not", () => {
    const old = sceneNumbers((content) => {
      const tasks = content.tasks as Record<string, unknown>;
      const closed = rowsOf(numbers, "returned")[0] as ChainTask;
      const row = taskRow(tasks, Number(closed.serial));
      row.resolvedAt =
        (content.asOf as { time: number }).time -
        (tasks.cut as { endedWithinSecs: number }).endedWithinSecs -
        DAY;
    });
    const closed = rowsOf(old, "returned")[0] as ChainTask;
    const got = alertsOf(input(old, { me: [OWED] }));
    expect(find(got, "ended", closed.serial)).toBeUndefined();
    expect(find(got, "claim", closed.serial)).toBeDefined();
  });
});

describe("whose news it is", () => {
  const numbers = sceneNumbers();

  it("a project the person does not hold makes none, and one whose holding is not known is asked about", () => {
    expect(alertsOf(input(numbers, { held: () => false }))).toEqual([]);
    const unknown = alertsResult(input(numbers, { held: () => "unknown" }));
    expect(unknown.alerts).toEqual([]);
    expect(unknown.unknownHeld).toEqual([numbers.key]);
  });

  it("a project with no news is not asked about, whatever the holding", () => {
    const quiet = sceneNumbers(
      withTasks((tasks) => {
        tasks.list = (tasks.list as Record<string, unknown>[]).filter(
          (r) => r.state === "cancelled",
        );
        tasks.openCount = 0;
      }),
    );
    expect(
      alertsResult(input(quiet, { held: () => "unknown" })).unknownHeld,
    ).toEqual([]);
  });

  it("a project with no queue, an unreadable one, or none told makes none", () => {
    const none = numbersFor();
    expect(none.tasks).toBeUndefined();
    expect(alertsOf(input(none))).toEqual([]);
    expect(alertsOf(input({ ...numbers, tasks: "unreadable" }))).toEqual([]);
    expect(alertsOf(input({ ...numbers, tasks: null }))).toEqual([]);
  });

  it("a record is read for its own project only: the names come by chain key", () => {
    const got = alertsOf(input(numbers, { names: new Map() }));
    expect(got[0]?.projectName).toBeNull();
    expect(got[0]?.words.startsWith("A project: ")).toBe(true);
  });

  it("the news of two projects keeps each one's ids apart", () => {
    const other = { ...numbers, key: `0x${"9".repeat(64)}` };
    const both = alertsOf(
      input(numbers, {
        numbers: [numbers, other],
        names: new Map([
          [numbers.key, "Lantern"],
          [other.key, "Orbit"],
        ]),
      }),
    );
    expect(new Set(ids(both)).size).toBe(both.length);
    expect(both.some((a) => a.words.startsWith("Orbit: "))).toBe(true);
  });
});

describe("the team's own words", () => {
  it("are used only where the record is the one the plan names and ties; else the news says a task", () => {
    const numbers = plannedNumbers();
    const row = plannedRowOf(numbers);
    const record = planTask({ usd: Number(row.maxDollars / 1_000_000n) });
    const tied = find(
      alertsOf(input(numbers, { tasksOf: () => [record] })),
      "planned",
      row.serial,
    );
    expect(tied?.said).toContain(`for “${record.what}”`);
    // A record that does not tie (another pay) is not trusted for its words.
    const loose = find(
      alertsOf(
        input(numbers, {
          tasksOf: () => [{ ...record, usd: record.usd ? record.usd + 1 : 1 }],
        }),
      ),
      "planned",
      row.serial,
    );
    expect(loose?.said).toContain("for a task");
    // A record that says the work is paid while the network says announced changes nothing about the news.
    const lying = find(
      alertsOf(
        input(numbers, {
          tasksOf: () => [{ ...record, state: "accepted", paidTx: "0xab" }],
        }),
      ),
      "planned",
      row.serial,
    );
    expect(lying?.kind).toBe("planned");
    expect(lying?.said).toContain("for a task");
  });

  it("a task that has since ended keeps its own words, because its record is the one its plan names", () => {
    const numbers = sceneNumbers((content) => {
      const paid = rowsOf(sceneNumbers(), "paid")[0] as ChainTask;
      taskRow(
        content.tasks as Record<string, unknown>,
        Number(paid.serial),
      ).what = `0x${TASK_ID}`;
    });
    const paid = rowsOf(numbers, "paid")[0] as ChainTask;
    const record = planTask({ state: "accepted", paidTx: "0xab" });
    const alert = find(
      alertsOf(input(numbers, { tasksOf: () => [record] })),
      "ended",
      paid.serial,
    );
    expect(alert?.said).toContain(`“${record.what}” was paid`);
  });

  it("a hostile task name is a short plain sentence: marks and quotes taken out, cut at 80 characters", () => {
    const numbers = plannedNumbers();
    const row = plannedRowOf(numbers);
    const hostile = `‮<img src=x onerror=alert(1)>"${"A".repeat(10_000)}`;
    const record = planTask({
      usd: Number(row.maxDollars / 1_000_000n),
      what: hostile,
    });
    const alert = find(
      alertsOf(input(numbers, { tasksOf: () => [record] })),
      "planned",
      row.serial,
    );
    expect(alert?.said).not.toContain("‮");
    expect(alert?.said).not.toContain('"');
    expect(alert?.said.length).toBeLessThan(400);
    expect(alert?.said).toContain("…”");
  });

  it("a hostile project name is cut and plain too", () => {
    const numbers = sceneNumbers();
    const alerts = alertsOf(
      input(numbers, {
        names: new Map([[numbers.key, `‮Lantern${"x".repeat(500)}`]]),
      }),
    );
    expect(alerts[0]?.words.split(": ")[0]?.length).toBeLessThanOrEqual(80);
    expect(alerts[0]?.words).not.toContain("‮");
  });
});

describe("a week later, and a record that has not been refreshed", () => {
  /** A plan with the notice the contracts give (14 days) so a week later it is still in its notice. */
  const longNotice = (content: Record<string, unknown>) => {
    const at = (content.asOf as { time: number }).time;
    const row = taskRow(
      content.tasks as Record<string, unknown>,
      PLANNED_SERIAL,
    );
    row.noticeEnd = at + 14 * DAY;
    row.expiresAt = at + 21 * DAY;
    row.announcedAt = at - 60;
  };

  it("a holder who was away a week still sees the planned task before its date, with the right date", () => {
    const numbers = sceneNumbers(longNotice);
    const row = plannedRowOf(numbers);
    const week = alertsOf(input(numbers, { now: numbers.asOf.time + 7 * DAY }));
    const alert = find(week, "planned", row.serial);
    expect(alert?.urgent).toBe(true);
    expect(alert?.before).toBe(row.noticeEnd);
    expect(alert?.said).toContain(`from ${timeText(row.noticeEnd)}`);
  });

  it("the record is then old: the news says so, and a notice that was true is not hidden by the silence", () => {
    const numbers = sceneNumbers(longNotice);
    const row = plannedRowOf(numbers);
    const alert = find(
      alertsOf(input(numbers, { now: numbers.asOf.time + 7 * DAY })),
      "planned",
      row.serial,
    );
    expect(alert?.stale).toBe(true);
    expect(alert?.old).toBe(true);
    expect(alert?.said).toContain(
      `(as of ${dayText(numbers.asOf.time)}, may be out of date)`,
    );
  });

  it("past three refresh periods the news says as of when, and a fresh record says nothing", () => {
    const numbers = sceneNumbers(longNotice);
    const row = plannedRowOf(numbers);
    const fresh = find(
      alertsOf(input(numbers, { now: numbers.builtAt + 60 })),
      "planned",
      row.serial,
    );
    expect(fresh?.stale).toBe(false);
    expect(fresh?.said).not.toContain("as of");
    const later = find(
      alertsOf(
        input(numbers, {
          now: numbers.builtAt + 3 * numbers.refreshEverySecs + 600,
        }),
      ),
      "planned",
      row.serial,
    );
    expect(later?.stale).toBe(true);
    expect(later?.old).toBe(false);
    expect(later?.said).toContain(`(as of ${timeText(numbers.asOf.time)})`);
  });

  it("a phone clock behind the record is lifted to it: an ended plan never reads as open", () => {
    const numbers = sceneNumbers((content) => {
      const row = taskRow(
        content.tasks as Record<string, unknown>,
        PLANNED_SERIAL,
      );
      row.noticeEnd = (content.asOf as { time: number }).time - 100;
      row.expiresAt = (content.asOf as { time: number }).time - 5;
    });
    const behind = alertsOf(
      input(numbers, { now: numbers.asOf.time - 30 * DAY }),
    );
    expect(find(behind, "planned", BigInt(PLANNED_SERIAL))).toBeUndefined();
  });

  it("an unrelated stranger's account has no claims on anyone's tasks", () => {
    expect(
      alertsOf(
        input(sceneNumbers(), { me: [STRANGER_EVM], held: () => false }),
      ),
    ).toEqual([]);
  });
});
