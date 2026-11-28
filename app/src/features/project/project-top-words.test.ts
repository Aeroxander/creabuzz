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
import { doorShutWords, smallDollarsText } from "../money/copy";
import {
  doorChip,
  keptLine,
  keptMoney,
  peopleLine,
  streakLine,
  takeOutNowLine,
  checkInLine,
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
      `Kept 30 days or more: ${keptMoney(rank?.money ?? 0n)} by ${rank?.accounts} people.`,
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

describe("the check-ins", () => {
  const when = (unix: number) => `at ${unix}`;
  it("names the last check-in and the weeks in a row from the record", () => {
    const n = parsedExample();
    const u = n.streaks?.updates;
    expect(u).toBeTruthy();
    expect(checkInLine(n, when)).toBe(
      `Last check-in at ${u?.lastAt}. Check-ins: ${u?.weeks} weeks in a row.`,
    );
  });

  it("says one week in the singular, and nothing of a run under one week", () => {
    expect(streakLine(1, 604_800)).toBe("Check-ins: 1 week in a row");
    expect(streakLine(0, 604_800)).toBeNull();
    const none = parsedWith((c) => {
      c.streaks.updates = {
        weeks: 0,
        longest: 3,
        lastAt: c.streaks.updates.lastAt,
      };
    });
    expect(checkInLine(none, when)).toMatch(/^Last check-in at \d+\.$/);
  });

  it("says no check-in yet when there has been none", () => {
    const n = parsedWith((c) => {
      c.streaks.updates = { weeks: 0, longest: 0, lastAt: null };
    });
    expect(checkInLine(n, when)).toBe("No check-in yet.");
  });

  it("without the streak key still says the last check-in, from the clock, and 'none' only at the birth of the project", () => {
    const older = parsedWith((c) => {
      delete c.streaks;
    });
    expect(checkInLine(older, when)).toBe(
      `Last check-in at ${older.clock.lastCheckIn}.`,
    );
    const birth = parsedWith((c) => {
      delete c.streaks;
      c.clock.lastCheckIn = c.launchedAt;
    });
    expect(checkInLine(birth, when)).toBe("No check-in yet.");
  });
});

describe("check-in and update are two words for two things", () => {
  const when = (unix: number) => `at ${unix}`;
  it("never calls the team's weekly mark on the network an update, so demo day's 'No update yet.' cannot contradict it", () => {
    const n = parsedExample();
    for (const line of [
      checkInLine(n, when),
      checkInLine(
        parsedWith((c) => {
          c.streaks.updates = { weeks: 0, longest: 0, lastAt: null };
        }),
        when,
      ),
      streakLine(3, 604_800) ?? "",
    ])
      expect(line).not.toMatch(/update/i);
  });
});

describe("the door chip", () => {
  it("says open or closed from the record", () => {
    const n = parsedExample();
    expect(doorChip(n, n.builtAt + 100)).toBe("Open to back");
    const shut = parsedWith((c) => (c.door.openNow = false));
    expect(doorChip(shut, shut.builtAt + 100)).toBe("Closed to new backers");
  });

  it("agrees with the Back box at the moment of looking: a quiet time that began after the record was built closes the chip too", () => {
    const n = parsedWith((c) => {
      c.quiet.quietFrom = c.builtAt - 60;
      c.quiet.dormantFrom = c.builtAt + 10_000_000;
      c.quiet.windableFrom = c.builtAt + 20_000_000;
      c.door.openNow = true;
      c.door.switchOn = true;
    });
    const at = n.builtAt + 30;
    expect(doorShutWords(n, at)).not.toBeNull();
    expect(doorChip(n, at)).toBe("Closed to new backers");
  });
});

describe("what a streak and the kept money say", () => {
  it("says weeks only for a week-long unit, and the unit's own length otherwise", () => {
    expect(streakLine(14, 604_800)).toBe("Check-ins: 14 weeks in a row");
    expect(streakLine(14, 1_680)).toBe(
      "Check-ins: 14 periods of 28 minutes in a row",
    );
    expect(streakLine(1, 1_680)).toBe(
      "Check-ins: 1 period of 28 minutes in a row",
    );
    const n = parsedWith((c) => {
      c.unit = 1_680;
    });
    expect(checkInLine(n, () => "just now")).not.toMatch(/weeks/);
  });

  it("never says the money of one person who kept it to the cent: it is said to the nearest 100 dollars", () => {
    const one = parsedWith((c) => {
      c.held.rank.accounts = 1;
      c.held.rank.money = "1234567890";
      c.held.countedAccounts = 3;
    });
    const line = keptLine(one) ?? "";
    expect(line).toMatch(/by 1 person\.$/);
    expect(line).toMatch(/about 1,200 dollars/);
    expect(line).not.toMatch(/1,234/);
    expect(keptMoney(40_000_000n)).toBe("under 100 dollars");
    expect(keptMoney(50_000_000n)).toBe("about 100 dollars");
  });
});
