// biome-ignore-all lint/suspicious/noExplicitAny: a record is changed as loose JSON, the way a hostile one arrives
// The sentences of the top of a project's page, made from the example the server's own code wrote. Every figure below is read
// from the parsed record and never typed; a case that needs the record to say something else changes the example's own fields.
import { describe, expect, it } from "vitest";
import { parseNumbers } from "../money/numbers";
import {
  exampleEvent,
  parsedExample,
  raw,
  SERVER,
} from "../../../tests/helpers/numbers-v2-parse";
import { smallDollarsText } from "../pot/pot-words";
import {
  doorChip,
  establishedRows,
  keptLine,
  peopleLine,
  streakLine,
  takeOutNowLine,
  updateLine,
  windowWords,
} from "./project-top-words";

type Json = Record<string, any>;
function parsedWith(change: (c: Json) => void) {
  const c = raw() as Json;
  change(c);
  const n = parseNumbers(exampleEvent(c), SERVER);
  if (!n || n.removed) throw new Error("did not parse");
  return n;
}

describe("who backs it and what taking out gives", () => {
  it("says it for none, one and many", () => {
    expect(peopleLine(0)).toBe("Nobody backs it yet.");
    expect(peopleLine(1)).toBe("1 person backs it.");
    expect(peopleLine(parsedExample().holderCount)).toBe(
      `${parsedExample().holderCount} people back it.`,
    );
    expect(peopleLine(1200)).toBe("1,200 people back it.");
  });

  it("gives what one Share gets from the record's own figure", () => {
    const n = parsedExample();
    expect(takeOutNowLine(n)).toBe(
      `Taking out now would give ${smallDollarsText(n.value.leaveValue)} for each Share.`,
    );
  });
});

describe("how long money has stayed", () => {
  it("names the window in the record's own length: days on a real network", () => {
    const n = parsedExample();
    expect(windowWords(n.held?.windows.rankSecs ?? 0)).toBe("30 days");
    expect(windowWords(n.held?.windows.badgeSecs ?? 0)).toBe("91 days");
  });

  it("says the money and the people when some has stayed", () => {
    const n = parsedExample();
    const rank = n.held?.rank;
    expect(rank).toBeTruthy();
    expect(keptLine(n)).toBe(
      `Kept 30 days or more: ${smallDollarsText(rank?.money ?? 0n)} by ${rank?.accounts} people.`,
    );
  });

  it("says one person, not one people", () => {
    const n = parsedWith((c) => {
      c.held.rank.accounts = 1;
    });
    expect(keptLine(n)).toMatch(/ by 1 person\.$/);
  });

  it("on a test network with a short unit the window is in minutes", () => {
    const n = parsedWith((c) => {
      c.held.windows.rankSecs = 720;
    });
    expect(keptLine(n)).toMatch(/^Kept 12 minutes or more: /);
  });

  it("says nobody has kept money in it that long, for a project older than the window", () => {
    const n = parsedWith((c) => {
      c.held.rank = {
        ...c.held.rank,
        money: "0",
        accounts: 0,
        shares: "0",
        bps: 0,
      };
    });
    expect(keptLine(n)).toBe("Nobody has kept money in it for 30 days yet.");
  });

  it("says too new to say, for a project younger than the window", () => {
    const n = parsedWith((c) => {
      c.held.rank = {
        ...c.held.rank,
        money: "0",
        accounts: 0,
        shares: "0",
        bps: 0,
      };
      c.launchedAt = c.asOf.time - c.held.windows.rankSecs + 60;
    });
    expect(keptLine(n)).toBe("Too new to say how long money stays.");
  });

  it("says nothing when the record cannot: a key that is null, missing, or a window it could not count", () => {
    expect(keptLine(parsedWith((c) => (c.held = null)))).toBeNull();
    expect(
      keptLine(
        parsedWith((c) => {
          delete c.held;
        }),
      ),
    ).toBeNull();
    expect(keptLine(parsedWith((c) => (c.held.rank = null)))).toBeNull();
  });
});

describe("the updates", () => {
  const when = (unix: number) => `at ${unix}`;
  it("names the last update and the weeks in a row from the record", () => {
    const n = parsedExample();
    const u = n.streaks?.updates;
    expect(u).toBeTruthy();
    expect(updateLine(n, when)).toBe(
      `Last update at ${u?.lastAt}. Updates: ${u?.weeks} weeks in a row.`,
    );
  });

  it("says one week in the singular, and nothing of a run under one week", () => {
    expect(streakLine(1)).toBe("Updates: 1 week in a row");
    expect(streakLine(0)).toBeNull();
    const none = parsedWith((c) => {
      c.streaks.updates = {
        weeks: 0,
        longest: 3,
        lastAt: c.streaks.updates.lastAt,
      };
    });
    expect(updateLine(none, when)).toMatch(/^Last update at \d+\.$/);
  });

  it("says no update yet when there has been none", () => {
    const n = parsedWith((c) => {
      c.streaks.updates = { weeks: 0, longest: 0, lastAt: null };
    });
    expect(updateLine(n, when)).toBe("No update yet.");
  });

  it("without the streak key still says the last update, from the clock, and 'none' only at the birth of the project", () => {
    const older = parsedWith((c) => {
      delete c.streaks;
    });
    expect(updateLine(older, when)).toBe(
      `Last update at ${older.clock.lastCheckIn}.`,
    );
    const birth = parsedWith((c) => {
      delete c.streaks;
      c.clock.lastCheckIn = c.launchedAt;
    });
    expect(updateLine(birth, when)).toBe("No update yet.");
  });
});

describe("the door chip", () => {
  it("says open or closed from the record", () => {
    expect(doorChip(parsedExample())).toBe("Open to back");
    expect(doorChip(parsedWith((c) => (c.door.openNow = false)))).toBe(
      "Closed to new backers",
    );
  });
});

describe("what Established means, line by line, from the record's own rule", () => {
  it("a project that reached it: every line met, and the numbers are the rule's", () => {
    const n = parsedWith((c) => {
      const e = c.established;
      e.heldBps = e.rule.minHeldBps;
      e.accounts = e.rule.minAccounts;
      e.twoSigners = true;
      e.reached = true;
    });
    const rows = establishedRows(n);
    expect(rows?.map((r) => r.met)).toEqual([true, true, true]);
    const rule = n.established?.rule;
    expect(rows?.[0].text).toBe(
      `Most of the money has stayed: ${(rule?.minHeldBps ?? 0) / 100}% of it has been here 91 days or more. It needs ${(rule?.minHeldBps ?? 0) / 100}%.`,
    );
    expect(rows?.[1].text).toBe(
      `At least ${rule?.minAccounts} people back it: ${rule?.minAccounts} do now.`,
    );
    expect(rows?.[2].text).toBe("Two people run it.");
  });

  it("a young project is told what is missing in the same words, never shamed", () => {
    const rows = establishedRows(parsedExample());
    expect(rows?.map((r) => r.met)).toEqual([true, false, false]);
    expect(rows?.[1].text).toMatch(
      /^Not yet: at least \d+ people need to back it, and \d+ do now\.$/,
    );
    expect(rows?.[2].text).toBe("One person runs it. Not yet: it needs two.");
    for (const row of rows ?? [])
      expect(row.text).not.toMatch(/fail|bad|worse/i);
  });

  it("a figure the record could not work out is 'not known yet', and no key gives no rows", () => {
    const unknown = parsedWith((c) => {
      c.held.badge = null;
      c.established.heldBps = null;
      c.established.reached = null;
    });
    expect(establishedRows(unknown)?.[0].met).toBeNull();
    expect(establishedRows(unknown)?.[0].text).toMatch(/not known yet/);
    expect(
      establishedRows(parsedWith((c) => (c.established = null))),
    ).toBeNull();
  });
});
