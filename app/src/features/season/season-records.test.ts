// Seasons as the records say them: a season record read strictly, an entry only when it names one project, one season and one
// family, and the project's place worked out the way the server works it out (newest by time then id, a removal over all).
import { describe, expect, it } from "vitest";
import {
  candidateCoordinates,
  currentSeason,
  entriesOf,
  isNotAnUpdate,
  liveCoordinates,
  parseEntry,
  parseSeason,
  phaseOf,
  type Season,
  type SeasonEntry,
  seasonsOf,
} from "./season-records";

const DAY = 86_400;
const T0 = 1_800_000_000;
const FOUNDER = "a".repeat(64);
const coordinate = (id: string) => `37001:${FOUNDER}:${id}`;

function seasonEvent(
  number: number,
  dates: Partial<{ startsAt: number; demoDayAt: number; endsAt: number }> = {},
  over: Record<string, unknown> = {},
) {
  return {
    id: `${number}`.padStart(64, "0"),
    pubkey: `${"0".repeat(63)}1`,
    kind: 37021,
    created_at: T0,
    tags: [["d", `season-${number}`]],
    content: JSON.stringify({
      v: 1,
      number,
      startsAt: T0,
      demoDayAt: T0 + 42 * DAY,
      endsAt: T0 + 49 * DAY,
      ...dates,
    }),
    ...over,
  };
}

function entryEvent(
  number: number,
  id: string,
  family: string,
  over: Record<string, unknown> = {},
) {
  return {
    id: `${id}-${family}`.padEnd(64, "0"),
    pubkey: FOUNDER,
    kind: 47003,
    created_at: T0,
    tags: [
      ["a", coordinate(id)],
      ["t", `season-${number}`],
      [`season-${family}`, String(number)],
    ],
    content: "{}",
    ...over,
  };
}

describe("a season record", () => {
  it("is read when it is whole and its dates run start, demo day, end", () => {
    expect(parseSeason(seasonEvent(3))).toMatchObject({
      number: 3,
      startsAt: T0,
      demoDayAt: T0 + 42 * DAY,
      endsAt: T0 + 49 * DAY,
    });
    // A demo day that is also the last day is allowed.
    expect(
      parseSeason(seasonEvent(3, { endsAt: T0 + 42 * DAY })),
    ).not.toBeNull();
  });

  it.each([
    ["the wrong kind", seasonEvent(3, {}, { kind: 1 })],
    ["a d that is not a season", seasonEvent(3, {}, { tags: [["d", "x"]] })],
    [
      "two d tags",
      seasonEvent(
        3,
        {},
        {
          tags: [
            ["d", "season-3"],
            ["d", "season-3"],
          ],
        },
      ),
    ],
    [
      "a number with a leading zero",
      seasonEvent(3, {}, { tags: [["d", "season-03"]] }),
    ],
    [
      "a number that is not the d",
      seasonEvent(4, {}, { tags: [["d", "season-3"]] }),
    ],
    ["demo day before the start", seasonEvent(3, { demoDayAt: T0 - 1 })],
    ["the end before demo day", seasonEvent(3, { endsAt: T0 + 41 * DAY })],
    [
      "a date that is not whole seconds",
      seasonEvent(3, { startsAt: T0 + 0.5 }),
    ],
    [
      "a date that is a string",
      seasonEvent(3, { startsAt: String(T0) as never }),
    ],
    ["content that is not JSON", seasonEvent(3, {}, { content: "no" })],
    ["content that is a list", seasonEvent(3, {}, { content: "[]" })],
  ])("is not read with %s", (_name, event) => {
    expect(parseSeason(event as never)).toBeNull();
  });

  it("keeps the newest record of each number, the higher id on a tie, the highest number first", () => {
    const seasons = seasonsOf([
      seasonEvent(1),
      seasonEvent(2, { demoDayAt: T0 + 40 * DAY }, { created_at: T0 }),
      seasonEvent(
        2,
        { demoDayAt: T0 + 41 * DAY },
        { created_at: T0 + 5, id: "f".repeat(64) },
      ),
      seasonEvent(
        2,
        { demoDayAt: T0 + 39 * DAY },
        { created_at: T0 + 5, id: "1".repeat(64) },
      ),
      seasonEvent(3, { demoDayAt: T0 }),
    ]);
    expect(seasons.map((s) => s.number)).toEqual([2, 1]);
    expect(seasons[0].demoDayAt).toBe(T0 + 41 * DAY);
  });
});

describe("where a season stands", () => {
  const season = parseSeason(seasonEvent(1)) as Season;
  it("changes at each date, and a date belongs to the phase it begins", () => {
    expect(phaseOf(season, season.startsAt - 1)).toBe("upcoming");
    expect(phaseOf(season, season.startsAt)).toBe("open");
    expect(phaseOf(season, season.demoDayAt - 1)).toBe("open");
    expect(phaseOf(season, season.demoDayAt)).toBe("demo");
    expect(phaseOf(season, season.endsAt - 1)).toBe("demo");
    expect(phaseOf(season, season.endsAt)).toBe("ended");
  });

  it("the band speaks of demo day first, then entry, then the next start, then the last to end", () => {
    const at = (n: number, start: number, demo: number, end: number) =>
      parseSeason(
        seasonEvent(n, {
          startsAt: T0 + start,
          demoDayAt: T0 + demo,
          endsAt: T0 + end,
        }),
      ) as Season;
    const ended = at(1, -90 * DAY, -48 * DAY, -41 * DAY);
    const ended2 = at(2, -80 * DAY, -38 * DAY, -31 * DAY);
    const demo = at(3, -43 * DAY, -1 * DAY, 6 * DAY);
    const open = at(4, -1 * DAY, 41 * DAY, 48 * DAY);
    const soon = at(5, 5 * DAY, 47 * DAY, 54 * DAY);
    const later = at(6, 9 * DAY, 51 * DAY, 58 * DAY);
    const now = T0;
    expect(currentSeason([], now)).toBeNull();
    expect(
      currentSeason([ended, ended2, demo, open, soon, later], now),
    ).toMatchObject({
      phase: "demo",
      season: { number: 3 },
    });
    expect(
      currentSeason([ended, ended2, open, soon, later], now),
    ).toMatchObject({
      phase: "open",
      season: { number: 4 },
    });
    expect(currentSeason([ended, ended2, later, soon], now)).toMatchObject({
      phase: "upcoming",
      season: { number: 5 },
    });
    expect(currentSeason([ended, ended2], now)).toMatchObject({
      phase: "ended",
      season: { number: 2 },
    });
  });
});

describe("an entry record", () => {
  it("names one project, one season and one family", () => {
    expect(parseEntry(entryEvent(3, "p", "entry"), 3)).toMatchObject({
      coordinate: coordinate("p"),
      family: "entry",
      signer: FOUNDER,
    });
    expect(parseEntry(entryEvent(3, "p", "leave"), 3)?.family).toBe("leave");
    expect(parseEntry(entryEvent(3, "p", "remove"), 3)?.family).toBe("remove");
  });

  it.each([
    [
      "another season's number in the family tag",
      entryEvent(4, "p", "entry"),
      3,
    ],
    [
      "no season tag",
      {
        ...entryEvent(3, "p", "entry"),
        tags: entryEvent(3, "p", "entry").tags.filter((t) => t[0] !== "t"),
      },
      3,
    ],
    [
      "two families",
      {
        ...entryEvent(3, "p", "entry"),
        tags: [...entryEvent(3, "p", "entry").tags, ["season-leave", "3"]],
      },
      3,
    ],
    [
      "two projects",
      {
        ...entryEvent(3, "p", "entry"),
        tags: [...entryEvent(3, "p", "entry").tags, ["a", coordinate("q")]],
      },
      3,
    ],
    [
      "an address that is not a project's",
      {
        ...entryEvent(3, "p", "entry"),
        tags: [
          ["a", "30023:x:y"],
          ["t", "season-3"],
          ["season-entry", "3"],
        ],
      },
      3,
    ],
    ["the wrong kind", entryEvent(3, "p", "entry", { kind: 1 }), 3],
    [
      "no family",
      {
        ...entryEvent(3, "p", "entry"),
        tags: [
          ["a", coordinate("p")],
          ["t", "season-3"],
        ],
      },
      3,
    ],
  ])("is not one with %s", (_name, event, number) => {
    expect(parseEntry(event as never, number as number)).toBeNull();
  });

  it("each record is counted once however many times it was read", () => {
    const e = entryEvent(3, "p", "entry");
    expect(entriesOf([e, e, entryEvent(3, "q", "entry")], 3)).toHaveLength(2);
  });
});

describe("who is in", () => {
  const entry = (
    id: string,
    family: SeasonEntry["family"],
    at: number,
    eid = `${id}${family}${at}`,
    signer = FOUNDER,
  ): SeasonEntry => ({
    id: eid.padEnd(64, "0"),
    signer,
    at,
    coordinate: coordinate(id),
    family,
  });

  it("the newest of entry and leave decides, whatever the order they were read in", () => {
    expect(
      liveCoordinates([entry("p", "leave", 20), entry("p", "entry", 10)]),
    ).toEqual([]);
    expect(
      liveCoordinates([
        entry("p", "entry", 10),
        entry("p", "leave", 20),
        entry("p", "entry", 30),
      ]),
    ).toEqual([coordinate("p")]);
  });

  it("two records in one second: the higher id decides, as the server does", () => {
    const low = entry("p", "entry", 10, "1");
    const high = entry("p", "leave", 10, "2");
    expect(liveCoordinates([low, high])).toEqual([]);
    expect(liveCoordinates([high, low])).toEqual([]);
    expect(
      liveCoordinates([
        entry("p", "leave", 10, "1"),
        entry("p", "entry", 10, "2"),
      ]),
    ).toEqual([coordinate("p")]);
  });

  it("a removal wins over an entry before it and after it, and over a later entry", () => {
    expect(
      liveCoordinates([entry("p", "entry", 10), entry("p", "remove", 20)]),
    ).toEqual([]);
    expect(
      liveCoordinates([entry("p", "remove", 5), entry("p", "entry", 10)]),
    ).toEqual([]);
    expect(
      liveCoordinates([
        entry("p", "entry", 10),
        entry("p", "remove", 20),
        entry("p", "entry", 30),
      ]),
    ).toEqual([]);
    // Another project is not touched by it.
    expect(
      liveCoordinates([entry("p", "remove", 20), entry("q", "entry", 10)]),
    ).toEqual([coordinate("q")]);
  });

  it("a record the caller will not count does not decide: an entry from a stranger is not a place, and a stranger's leave takes none", () => {
    const stranger = "c".repeat(64);
    const entries = [
      entry("p", "entry", 10),
      entry("p", "leave", 20, "x", stranger),
      entry("q", "entry", 10, "y", stranger),
    ];
    expect(liveCoordinates(entries, (e) => e.signer === FOUNDER)).toEqual([
      coordinate("p"),
    ]);
  });
});

describe("what is not an update", () => {
  it("a season entry, leave or removal and a room stop are records about the project, not what the team said", () => {
    for (const name of [
      "season-entry",
      "season-leave",
      "season-remove",
      "room-mute",
    ])
      expect(
        isNotAnUpdate([
          ["a", "x"],
          [name, "1"],
        ]),
      ).toBe(true);
    expect(
      isNotAnUpdate([
        ["a", "x"],
        ["t", "season-1"],
      ]),
    ).toBe(false);
    expect(isNotAnUpdate([])).toBe(false);
  });
});

describe("who may be in, before each project is checked", () => {
  const stranger = "c".repeat(64);
  const make = (
    id: string,
    family: SeasonEntry["family"],
    at: number,
    signer = FOUNDER,
  ): SeasonEntry => ({
    id: `${id}${family}${at}${signer.slice(0, 2)}`.padEnd(64, "0"),
    signer,
    at,
    coordinate: coordinate(id),
    family,
  });

  it("a founder's leave takes a project out, and a stranger's leave does not", () => {
    expect(
      candidateCoordinates([make("p", "entry", 10), make("p", "leave", 20)]),
    ).toEqual([]);
    expect(
      candidateCoordinates([
        make("p", "entry", 10),
        make("p", "leave", 20, stranger),
      ]),
    ).toEqual([coordinate("p")]);
  });

  it("an entry from someone who is not the founder is kept for the second pass, and a removal still wins", () => {
    expect(candidateCoordinates([make("p", "entry", 10, stranger)])).toEqual([
      coordinate("p"),
    ]);
    expect(
      candidateCoordinates([
        make("p", "entry", 10, stranger),
        make("p", "remove", 20, stranger),
      ]),
    ).toEqual([]);
  });

  it("an entry after a founder's leave puts the project back", () => {
    expect(
      candidateCoordinates([
        make("p", "entry", 10),
        make("p", "leave", 20),
        make("p", "entry", 30, stranger),
      ]),
    ).toEqual([coordinate("p")]);
  });
});
