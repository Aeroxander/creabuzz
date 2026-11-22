// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON, the way a hostile one arrives
/**
 * The milestone 9 keys: every rule of `docs/next-version/COUNCIL-PLAN.md` 5.2 and every row of the 6.6 table, one at a
 * time. The fixture is the one example the server and the app both test against, with a Council runner and one ballot added
 * (`tests/helpers/council-v2-parse.ts`): nothing here is retyped from the contract.
 */
import { describe, expect, it } from "vitest";
import { freshnessOf } from "./numbers";
import {
  councilPlain,
  councilRaw,
  councilRecord,
  DAY,
  NOW,
  WAIT,
  type BallotCase,
} from "../../../tests/helpers/council-v2-parse";
import { withStepKeys } from "./numbers-step9";

const parse = councilRecord;
const cases: BallotCase[] = [
  "standing",
  "voting",
  "moved",
  "waiting",
  "counting",
  "carried-out",
  "lapsed",
  "kept",
  "short",
  "seated",
  "unchanged",
];

describe("the milestone 9 keys: a project with neither shows nothing new (6.6 row 1)", () => {
  it("the ordinary example leaves runner.kind, council and vote out; Pair behaviour is unchanged", () => {
    const n = councilPlain();
    expect(n.vote).toBeUndefined();
    expect(n.council).toBeUndefined();
    expect("vote" in n).toBe(false);
    expect("council" in n).toBe(false);
    expect(n.runner.kind).toBeUndefined();
    expect(n.runner.isPair).toBe(false);
    // the money and the step 4 keys are exactly what they were
    expect(n.money.pot).toBe(councilPlain().money.pot);
    expect(n.pause).toBeNull();
  });

  it("an older record signed without these keys keeps its undecoded keys and reads as before", () => {
    const n = councilPlain();
    // The keys are kept as signed by `numbers.ts`, and read by `withStepKeys` only with the lazy screens.
    const again = withStepKeys(n);
    expect("vote" in again).toBe(false);
    expect(again.money.pot).toBe(n.money.pot);
  });
});

describe("the milestone 9 keys: a Council runner reads field by field", () => {
  const n = parse("voting");

  it("runner.kind and runner.seats", () => {
    expect(n.runner.kind).toBe("council");
    expect(n.runner.seats).toBe(5);
    expect(n.runner.isPair).toBe(false);
  });

  it("the Council block", () => {
    expect(n.council?.contract).toBe(
      "0xa513e6e4b8a2f1c6c1f0e0e5b9b0a5b8de9c2b41",
    );
    expect(n.council?.seats).toHaveLength(5);
    expect(n.council?.seats[0]?.account).toBe(
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    );
    expect(n.council?.seats[0]?.seatedAt).toBe(NOW - DAY);
    expect(n.council?.needed).toBe(3);
    expect(n.council?.generation).toBe(1);
    expect(n.council?.nextElection).toBe(NOW + 20 * DAY);
    expect(n.council?.upSeats).toEqual([0, 1]);
    expect(n.council?.waiting).toEqual({
      count: 1,
      kinds: [{ kind: "draw", count: 1 }],
      truncated: false,
    });
  });

  it("the vote rule: every number a sentence needs, from the contract", () => {
    expect(n.vote?.rule).toEqual({
      standSecs: DAY,
      voteSecs: 3 * DAY,
      waitSecs: WAIT,
      floorDivisor: 3,
      openDivisor: 20,
      standDivisor: 1_000,
      cooldownSecs: 28 * DAY,
      seatsEverySecs: 182 * DAY,
      proposalTtlSecs: 14 * DAY,
      needed: 3,
      seats: 5,
      maxLists: 4,
      maxPeople: 12,
      minVote: 1_000_000_000_000_000_000n,
    });
  });

  it("the open ballot", () => {
    expect(n.vote?.open?.id).toBe(3);
    expect(n.vote?.open?.kind).toBe("replace");
    expect(n.vote?.open?.phase).toBe("voting");
    expect(n.vote?.open?.openedAt).toBe(NOW - 2 * DAY);
    expect(n.vote?.open?.standEnd).toBe(NOW - DAY);
    expect(n.vote?.open?.voteEnd).toBe(NOW + 2 * DAY);
    expect(n.vote?.open?.effectiveAt).toBe(NOW + 2 * DAY + 1_425_600);
    expect(n.vote?.open?.supply).toBe(1_000_000n * 10n ** 18n);
    expect(n.vote?.open?.floor).toBe((1_000_000n * 10n ** 18n + 2n) / 3n);
    expect(n.vote?.open?.cast).toBe(400_000n * 10n ** 18n);
    expect(n.vote?.open?.options.map((o) => o.kind)).toEqual(["keep", "list"]);
    expect(n.vote?.open?.options[1]?.members).toHaveLength(5);
    expect(n.vote?.open?.result).toBeNull();
    expect(n.vote?.open?.carriedOutAt).toBeNull();
    // No Council section without a next election; here both are the record's.
    expect(n.vote?.next.seatsAt).toBe(n.council?.nextElection);
    expect(n.vote?.next.replaceFrom).toBe(NOW);
    expect(n.vote?.next.openFloor).toBe(50_000n * 10n ** 18n);
  });

  it("every phase the screens name reads", () => {
    for (const testCase of cases) {
      const parsed = parse(testCase);
      expect(parsed.vote?.open, testCase).not.toBeNull();
    }
    expect(parse("standing").vote?.open?.phase).toBe("standing");
    expect(parse("waiting").vote?.open?.phase).toBe("waiting");
    expect(parse("counting").vote?.open?.phase).toBe("counting");
    expect(parse("carried-out").vote?.open?.phase).toBe("carried-out");
    expect(parse("lapsed").vote?.open?.phase).toBe("lapsed");
    expect(parse("kept").vote?.open?.phase).toBe("ended");
    expect(parse("short").vote?.open?.result).toEqual({
      outcome: "short",
      winners: [],
      recorded: true,
    });
    expect(parse("moved").vote?.open?.result).toEqual({
      outcome: "moved",
      winners: [1],
      recorded: false,
    });
    expect(parse("seated").vote?.open?.result).toEqual({
      outcome: "seated",
      winners: [1, 2],
      recorded: false,
    });
    expect(parse("unchanged").vote?.open?.result).toEqual({
      outcome: "unchanged",
      winners: [],
      recorded: true,
    });
  });
});

describe("the milestone 9 keys: a key that cannot be believed is null and the record stands (6.6 rows 2 to 4)", () => {
  const stands = (n: ReturnType<typeof parse>) => {
    expect(n.money.pot).toBe(councilPlain().money.pot);
    // The rest of the record keeps its own keys.
    expect(n.runner.kind).toBe("council");
  };

  it("6.6 row 2: a Council that is null or malformed leaves the Council null, never a section", () => {
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council = null;
      }),
    );
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council.seats = r.council.seats.slice(0, 4);
      }),
    );
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council.seats[0].account = r.council.seats[1].account;
      }),
    );
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council.needed = 6;
      }),
    );
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council.upSeats = [0, 5];
      }),
    );
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council.contract = "0x0000000000000000000000000000000000000001";
      }),
    );
    // A held seat without a date, and an open one with a date, are not believed either.
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council.seats[0].seatedAt = null;
      }),
    );
    // The waiting count is the sum of its kinds unless it says it was cut.
    expectsCouncilUnreadable(
      parse("voting", (r) => {
        r.council.waiting.count = 2;
      }),
    );
    // A runner that says "council" with a Council that reads: the seats' count is the runner's.
    const seats = parse("voting", (r) => {
      r.runner.seats = 4;
    });
    expect(seats.runner.seats).toBeNull();
    expect(seats.council).not.toBeNull();
  });

  it("6.6 row 3: vote null while the project has a vote contract shows nothing about a vote", () => {
    const n = parse("voting", (r) => {
      r.vote = null;
    });
    expect(n.vote).toBeNull();
    expect(n.council).not.toBeNull();
    expect(n.contracts.pause).toBe(
      "0x0165878a594ca255338adfa4d48449f69242eb8f",
    );
  });

  it("6.6 row 4: a hostile vote nulls the vote and the rest stands, case by case", () => {
    const hostile: Array<[string, (r: any) => void]> = [
      [
        "tallies that do not add up to the cast",
        (r) => {
          r.vote.open.options[0].tally = "1";
        },
      ],
      [
        "the times out of order",
        (r) => {
          r.vote.open.standEnd = r.vote.open.openedAt - 1;
        },
      ],
      [
        "a stand window that is not the rule's day",
        (r) => {
          r.vote.open.standEnd = r.vote.open.openedAt + 2 * DAY;
        },
      ],
      [
        "a vote that is not the rule's three days",
        (r) => {
          r.vote.open.voteEnd = r.vote.open.standEnd + 2 * DAY;
        },
      ],
      [
        "a wait that is not the rule's",
        (r) => {
          r.vote.open.effectiveAt = r.vote.open.voteEnd + DAY;
        },
      ],
      [
        "a floor that is not supply over its divisor",
        (r) => {
          r.vote.open.floor = "1";
        },
      ],
      [
        "a cast total above the supply",
        (r) => {
          r.vote.open.cast = (1_000_001n * 10n ** 18n).toString();
          r.vote.open.options[0].tally = r.vote.open.cast;
          r.vote.open.options[1].tally = "0";
        },
      ],
      [
        "a cast total above what is parked while the vote runs",
        (r) => {
          // A readable pause, with less parked than cast: the vote stops being believed.
          r.contracts.pause = "0x0165878a594ca255338adfa4d48449f69242eb8f";
          r.pause = {
            contract: r.contracts.pause,
            parkedTotal: (100_000n * 10n ** 18n).toString(),
            line: ((BigInt(r.shares.backers) + 2n) / 3n).toString(),
            dayLength: DAY,
            lineDivisor: 3,
            armedAt: null,
            pausesFrom: null,
            paused: false,
            since: null,
            parkerCount: 1,
          };
        },
      ],
      [
        "a result before the vote has ended",
        (r) => {
          r.vote.open.result = {
            outcome: "kept",
            winners: [],
            recorded: false,
          };
        },
      ],
      [
        "a result that is not the one the tallies give",
        (r) => {
          // The moved case's own times and tallies, with a "kept" result: the two cannot both be true.
          r.vote.open = { ...councilRaw("moved").vote.open };
          r.vote.open.result = {
            outcome: "kept",
            winners: [],
            recorded: false,
          };
        },
      ],
      [
        "a phase that denies its own times",
        (r) => {
          r.vote.open.phase = "waiting";
        },
      ],
      [
        "a carried-out time before the result was due",
        (r) => {
          r.vote.open.carriedOutAt = r.vote.open.effectiveAt - 1;
        },
      ],
      [
        "a rule whose Council shape is not five seats",
        (r) => {
          r.vote.rule.seats = 4;
        },
      ],
      [
        "a rule whose threshold is not the Council's",
        (r) => {
          r.vote.rule.needed = 2;
        },
      ],
      [
        "a vote contract that is not the project's pause",
        (r) => {
          r.vote.contract = "0x0000000000000000000000000000000000000002";
          r.contracts.pause = "0x0000000000000000000000000000000000000003";
        },
      ],
      [
        "an option that is not the ballot's kind",
        (r) => {
          r.vote.open.options[1].kind = "person";
        },
      ],
      [
        "a list that is not five different accounts",
        (r) => {
          r.vote.open.options[1].members = r.vote.open.options[1].members.slice(
            0,
            4,
          );
        },
      ],
      [
        "a next election that is not the Council's",
        (r) => {
          r.vote.next.seatsAt = 1;
        },
      ],
    ];
    for (const [why, change] of hostile) {
      const n = parse("voting", change);
      expect(n.vote, why).toBeNull();
      stands(n);
      expect(n.council, why).not.toBeNull();
    }
  });

  it("6.6 row 5: a record older than its own promise is stale, and the card says the stale sentence", () => {
    const n = parse("voting");
    // The record's own `builtAt` and `refreshEverySecs` decide it, exactly as for every other key.
    expect(freshnessOf(n, n.builtAt + 10).level).toBe("fresh");
    expect(freshnessOf(n, n.builtAt + 24 * 60 * 60 + 1).level).toBe("stale");
  });
});

function expectsCouncilUnreadable(n: ReturnType<typeof parse>): void {
  expect(n.council).toBeNull();
  expect(n.runner.kind).toBe("council");
}
