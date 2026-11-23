// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON
/**
 * Every sentence of the vote card, built from a record and from a changed rule: the number in the sentence follows the
 * record's own `vote.rule` and `council.needed`, and no sentence uses a forbidden word (COUNCIL-PLAN.md section 6).
 */
import { describe, expect, it } from "vitest";
import * as words from "./vote-words";
import { PUBLIC_LINE as ROOM_PUBLIC_LINE } from "../room/room-words";
import { TAKE_OUT_BANNER as POT_BANNER } from "../pot/pot-words";
import {
  councilRecord,
  DAY,
  NOW,
  type BallotCase,
} from "../../../tests/helpers/council-v2-parse";

const replace = (testCase: BallotCase = "voting", change?: (r: any) => void) =>
  councilRecord(testCase, change);
const seats = (testCase: BallotCase, change?: (r: any) => void) =>
  councilRecord(testCase, change);

const nameOf = (address: string) => `name-${address.slice(2, 6)}`;
const open = (n: ReturnType<typeof replace>) => n.vote!.open!;
const rule = (n: ReturnType<typeof replace>) => n.vote!.rule;

describe("the vote card's head and state lines", () => {
  it("the title names the kind, and the seats come from the Council", () => {
    const n = replace("voting");
    expect(words.voteTitle({ vote: open(n), council: n.council ?? null })).toBe(
      "A vote on who runs this project",
    );
    const s = seats("seats");
    expect(words.voteTitle({ vote: open(s), council: s.council ?? null })).toBe(
      "Two seats on the Council are up",
    );
    // The number follows the Council's own seats that come up.
    const one = seats("seats");
    expect(
      words.voteTitle({
        vote: open(one),
        council: {
          ...one.council!,
          upSeats: [0] as unknown as [number, number],
        },
      }),
    ).toBe("One seat on the Council is up");
    expect(words.countWord(2)).toBe("two");
  });

  it("the replace intro says how many accounts a new Council has, from the rule", () => {
    const n = replace("voting");
    expect(words.replaceIntro(rule(n))).toBe(
      "Holders are choosing between keeping things as they are and a new Council of five accounts.",
    );
  });

  it("the standing line names the end of the first day and, for a replace vote, the list size", () => {
    const n = replace("standing");
    expect(
      words.standingLine({
        vote: open(n),
        rule: rule(n),
        council: n.council ?? null,
      }),
    ).toContain("can put forward a list of five accounts until");
    const s = seats("seats-standing");
    expect(
      words.standingLine({
        vote: open(s),
        rule: rule(s),
        council: s.council ?? null,
      }),
    ).toBe(
      `Two of the five seats are being voted on. Anyone with parked Shares can stand until ${new Date(open(s).standEnd * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`,
    );
  });

  it("the voting line names the end from the record", () => {
    const n = replace("voting");
    expect(words.votingLine(open(n))).toMatch(/^Voting ends /);
  });
});

describe("the count line: every percent from the rule, never the floor while under it", () => {
  it("says what part has voted, the floor, and how a choice wins", () => {
    const n = replace("voting");
    expect(words.countLine(open(n), rule(n))).toBe(
      "40% of Shares have voted. The vote counts when at least 33% do, and a list wins with more than half of the votes cast.",
    );
    const s = seats("seats");
    expect(words.countLine(open(s), rule(s))).toContain(
      "and a person wins when more Shares are for them than for keeping the seat as it is.",
    );
  });

  it("a value under the floor never reads as the floor", () => {
    // 333,333 of 1,000,000 reads 33% and the floor is 33%: it must not read as met.
    const n = replace("voting", (r) => {
      r.vote.open.cast = (333_333n * 10n ** 18n).toString();
      r.vote.open.options[0].tally = (200_000n * 10n ** 18n).toString();
      r.vote.open.options[1].tally = (133_333n * 10n ** 18n).toString();
    });
    expect(words.countLine(open(n), rule(n))).toMatch(
      /^Less than 33% of Shares have voted\./,
    );
  });

  it("the floor follows the rule: a divisor of 4 says 25%", () => {
    const n = replace("voting", (r) => {
      r.vote.rule.floorDivisor = 4;
      r.vote.open.floor = (250_000n * 10n ** 18n).toString();
    });
    expect(words.floorPercent(rule(n))).toBe(25n);
    expect(words.countLine(open(n), rule(n))).toContain("at least 25% do");
  });
});

describe("the rows: words, percents and the press's own name", () => {
  it("keep and list rows", () => {
    const n = replace("voting");
    const [keep, list] = open(n).options;
    expect(
      words.optionWords({
        option: keep!,
        kind: "replace",
        council: n.council ?? null,
        nameOf,
      }),
    ).toBe("Keep things as they are");
    expect(
      words.optionWords({
        option: list!,
        kind: "replace",
        council: n.council ?? null,
        nameOf,
      }),
    ).toMatch(
      /^List 1: name-976e, name-14dc, name-2361, name-a0ee, name-bcd4$/,
    );
    expect(words.optionPercent(open(n), list!)).toBe("25%");
    expect(words.proposerLine(list!, nameOf)).toBe(
      "Put forward by name-7099. Nobody on a list has to agree to it.",
    );
    expect(words.proposerLine(keep!, nameOf)).toBe("");
  });

  it("the seat rows say 'the two seats' and a person's own name", () => {
    const n = seats("seated");
    expect(words.keepRowWords("seats", n.council ?? null)).toBe(
      "Keep the two seats as they are",
    );
    const person = open(n).options[1]!;
    expect(
      words.optionWords({
        option: person,
        kind: "seats",
        council: n.council ?? null,
        nameOf,
      }),
    ).toBe("name-7099");
  });

  it("each press has its own name: keep, a list by its number and first account, a person", () => {
    const n = replace("voting");
    const [keep, list] = open(n).options;
    expect(
      words.votePressName({
        option: keep!,
        kind: "replace",
        council: n.council ?? null,
        nameOf,
      }),
    ).toBe("Vote to keep things as they are");
    expect(
      words.votePressName({
        option: list!,
        kind: "replace",
        council: n.council ?? null,
        nameOf,
      }),
    ).toBe(
      "Vote for List 1: name-976e, name-14dc, name-2361, name-a0ee, name-bcd4",
    );
    expect(words.standPressWords("replace")).toBe("Put forward a list");
    expect(words.standPressWords("seats")).toBe("Stand for a seat");
    expect(words.YOUR_VOTE).toBe("Your vote");
  });
});

describe("what the card says after the vote", () => {
  it("the planned change names who takes over, from whom, and when", () => {
    const n = replace("moved");
    const line = words.plannedChangeLine({
      vote: open(n),
      nameOf,
      runnerKind: "council",
    });
    expect(line).toContain(
      "Holders voted to change who runs this project. On ",
    );
    expect(line).toContain("take over from the Council.");
    expect(line).toContain(
      "You can take your money out before then. Taking out stays open.",
    );
    expect(line).toContain("name-976e");
    // The runner being replaced is the record's kind, in plain words.
    expect(
      words.plannedChangeLine({
        vote: open(n),
        nameOf,
        runnerKind: "single",
      }),
    ).toContain("take over from the founder.");
    expect(
      words.plannedChangeLine({
        vote: open(n),
        nameOf,
        runnerKind: "pair",
      }),
    ).toContain("take over from the two-person team.");
  });

  it("a seat election's result names the winners, or says the seats stay", () => {
    const n = seats("seated");
    expect(words.seatsResultLine({ vote: open(n), nameOf })).toContain(
      "name-7099 and name-3c44 take their seats on ",
    );
    const stayed = seats("unchanged");
    expect(words.seatsResultLine({ vote: open(stayed), nameOf })).toBe(
      "The vote ended. The seats stay as they are.",
    );
  });

  it("a result that changes nothing, the last line and the stale sentence", () => {
    expect(words.endedLine()).toBe("The vote ended. Nothing changes.");
    expect(words.lastLine()).toContain(
      "A vote only changes who runs this project. Taking out stays open",
    );
    expect(words.staleLine()).toBe(
      "These numbers are older than the server promises, so nothing is said here about where the vote stands now.",
    );
  });

  it("what a visitor and an ineligible holder read", () => {
    expect(words.onlyBackersLine()).toBe(
      "Only people who back this project can vote.",
    );
    expect(words.CANNOT_VOTE).toBe(
      "You can't vote in this one. Only Shares parked before it opened count. You can take your money out any time.",
    );
  });

  it("the stand sheet's opening sentence counts the rule's own days", () => {
    const n = replace("voting");
    const said = words.openVoteSentence(rule(n));
    expect(said).toContain("For the first one day anyone with parked Shares");
    expect(said).toContain("Then holders vote for three days.");
    expect(said).toContain("Nothing changes for 16.5 days after that");
    // A changed wait changes the sentence.
    const longer = replace("voting", (r) => {
      r.vote.rule.waitSecs = 20 * DAY;
      r.vote.open.effectiveAt = r.vote.open.voteEnd + 20 * DAY;
    });
    expect(words.openVoteSentence(rule(longer))).toContain(
      "Nothing changes for 20 days after that",
    );
  });

  it("the runner's own line and the opener's line carry no typed number", () => {
    expect(words.plannedTaskWeightLine(NOW + 100)).toContain(
      "Until then you still run it.",
    );
    expect(words.openerLine()).toBe(
      "Enough Shares are parked to ask holders who should run this project.",
    );
  });

  it("a candidate's text is shown only when its record is the chain's hash", () => {
    expect(
      words.candidacyText("0x" + "ab".repeat(32), {
        id: "0x" + "ab".repeat(32),
        text: "I would run it plainly.",
      }),
    ).toBe("I would run it plainly.");
    expect(
      words.candidacyText("0x" + "ab".repeat(32), {
        id: "0x" + "cd".repeat(32),
        text: "Wrong text.",
      }),
    ).toBe(words.NO_TEXT);
    expect(words.candidacyText(null, null)).toBe("No text");
  });
});

describe("the words the card may never use, and the two constants it reuses", () => {
  it("reuses the room's public line and the shell's banner word for word", () => {
    expect(words.PUBLIC_LINE).toBe(ROOM_PUBLIC_LINE);
    expect(words.PUBLIC_LINE).toBe("Posts and votes are public.");
    expect(words.TAKE_OUT_BANNER).toBe(POT_BANNER);
  });

  it("no sentence uses a section 6 forbidden word, and no sentence says 'five people'", () => {
    const sentences = everySentence();
    for (const sentence of sentences) {
      for (const forbidden of words.FORBIDDEN_WORDS) {
        const pattern =
          forbidden === "five people"
            ? /five\s+people/i
            : new RegExp(`\\b${forbidden}\\b`, "i");
        expect(pattern.test(sentence), `${forbidden} in "${sentence}"`).toBe(
          false,
        );
      }
    }
    expect(sentences.length).toBeGreaterThan(20);
  });
});

/** Every sentence the card can show, built from records in their phases. */
function everySentence(): string[] {
  const n = replace("moved");
  const live = replace("voting");
  const seat = seats("seated");
  const [, list] = open(live).options;
  const kept = replace("kept");
  const out: string[] = [
    words.voteTitle({ vote: open(live), council: live.council ?? null }),
    words.voteTitle({ vote: open(seat), council: seat.council ?? null }),
    words.replaceIntro(rule(live)),
    words.standingLine({
      vote: open(live),
      rule: rule(live),
      council: live.council ?? null,
    }),
    words.standingLine({
      vote: open(seat),
      rule: rule(seat),
      council: seat.council ?? null,
    }),
    words.votingLine(open(live)),
    words.countLine(open(live), rule(live)),
    words.countLine(open(seat), rule(seat)),
    words.seatsStayLine(),
    words.staleLine(),
    words.keepRowWords("replace", live.council ?? null),
    words.keepRowWords("seats", seat.council ?? null),
    words.optionWords({
      option: list!,
      kind: "replace",
      council: null,
      nameOf,
    }),
    words.optionPercent(open(live), list!),
    words.proposerLine(list!, nameOf),
    words.votePressName({
      option: list!,
      kind: "replace",
      council: null,
      nameOf,
    }),
    words.votePressName({
      option: open(live).options[0]!,
      kind: "replace",
      council: null,
      nameOf,
    }),
    words.onlyBackersLine(),
    words.CANNOT_VOTE,
    words.plannedChangeLine({ vote: open(n), nameOf, runnerKind: "single" }),
    words.seatsResultLine({ vote: open(seat), nameOf }),
    words.seatsResultLine({ vote: open(seats("unchanged")), nameOf }),
    words.endedLine(),
    words.lastLine(),
    words.openVoteSentence(rule(live)),
    words.plannedTaskWeightLine(open(n).effectiveAt),
    words.openerLine(),
    words.standPressWords("replace"),
    words.standPressWords("seats"),
    words.YOUR_VOTE,
    words.plannedChangeLine({ vote: open(n), nameOf, runnerKind: "pair" }),
    words.plannedChangeLine({ vote: open(n), nameOf, runnerKind: "council" }),
    words.keepRowWords("seats", null),
    words.optionWords({
      option: open(kept).options[0]!,
      kind: "replace",
      council: null,
      nameOf,
    }),
  ];
  return out;
}
