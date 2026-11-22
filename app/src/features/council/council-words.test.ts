// biome-ignore-all lint/suspicious/noExplicitAny: the record is walked as loose JSON
/**
 * The Council's words: the refusals of the plan's 6.2 table, keyed by what the network refused (never by its name), the
 * Council section (6.4) and the hand-over sheet (6.5). Every sentence says what happened and what to do next, and uses none
 * of the forbidden words of section 6.
 */
import { describe, expect, it } from "vitest";
import * as words from "./council-words";
import { PUBLIC_LINE as ROOM_PUBLIC_LINE } from "../room/room-words";
import { councilRecord, NOW } from "../../../tests/helpers/council-v2-parse";

const rule = (n: ReturnType<typeof councilRecord>) => n.vote!.rule;
const council = (n: ReturnType<typeof councilRecord>) => n.council!;
const nameOf = (address: string) => `name-${address.slice(2, 6)}`;

/** A failed step that carries the contract's refusal, the way a wallet or a node reports it. */
const refused = (name: string) => new Error(`execution reverted: ${name}()`);

describe("the refusals of the plan's 6.2 table, keyed by the network's refusal", () => {
  const n = councilRecord("voting");
  const context = { rule: rule(n), council: council(n), nameOf };

  it("a vote cast by Shares not parked before it opened", () => {
    expect(words.refusalOf(refused("NotEligible"), "vote")).toBe(
      "not-eligible-vote",
    );
    expect(words.refusalWords("not-eligible-vote", context)).toContain(
      "You can't vote in this one. Only Shares parked before it opened count.",
    );
  });

  it("the vote ended while the press was open", () => {
    expect(words.refusalOf(refused("VotingClosed"), "vote", "voting")).toBe(
      "vote-ended",
    );
    expect(words.refusalWords("vote-ended", context)).toBe(
      "This vote has ended. Nothing was sent. The result is on the project page.",
    );
  });

  it("voting before the names are final names the time", () => {
    expect(words.refusalOf(refused("VotingClosed"), "vote", "standing")).toBe(
      "voting-not-started",
    );
    expect(words.refusalWords("voting-not-started", context, NOW)).toContain(
      "Voting starts at ",
    );
    expect(words.refusalWords("voting-not-started", context)).toContain(
      "when the names are final.",
    );
  });

  it("standing with too little parked, and standing twice", () => {
    expect(words.refusalOf(refused("NotEligible"), "stand")).toBe(
      "not-eligible-stand",
    );
    expect(words.refusalWords("not-eligible-stand", context)).toContain(
      "parked from before the vote opened",
    );
    expect(words.refusalOf(refused("AlreadyStood"), "stand")).toBe(
      "already-stood",
    );
    expect(words.refusalWords("already-stood", context)).toContain(
      "You already put a name forward in this vote.",
    );
    expect(words.refusalWords("bad-members", context)).toContain(
      "A list needs five different accounts.",
    );
  });

  it("a list that names an account of the project, and a seat already held", () => {
    expect(words.refusalOf(refused("ProjectAccount"), "stand-list")).toBe(
      "project-account",
    );
    expect(words.refusalWords("project-account", context)).toBe(
      "These accounts belong to the project and cannot hold a seat. Nothing was sent.",
    );
    expect(words.refusalOf(refused("HoldsSeat"), "stand")).toBe("holds-seat");
    expect(
      words.refusalWords("holds-seat", {
        ...context,
        account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      }),
    ).toContain("name-7099 already holds a seat.");
  });

  it("a place a larger stake took", () => {
    expect(words.refusalOf(refused("NoRoom"), "stand")).toBe("no-room");
    expect(words.refusalWords("no-room", context)).toContain(
      "Every place is taken by a name with more Shares parked",
    );
  });

  it("opening a vote too soon: the cooldown says how long, from the rule", () => {
    expect(words.refusalOf(refused("Cooldown"), "open-replace")).toBe(
      "cooldown",
    );
    expect(words.refusalWords("cooldown", context)).toBe(
      "A vote can't open yet: holders said no to the last one less than 28 days ago. Nothing was sent.",
    );
    expect(words.refusalOf(refused("NotEligible"), "open-replace")).toBe(
      "not-eligible-open",
    );
    expect(words.refusalWords("not-eligible-open", context)).toContain(
      "Not enough Shares are parked yet",
    );
    expect(words.refusalOf(refused("BallotLive"), "open-replace")).toBe(
      "vote-open",
    );
    expect(words.refusalWords("vote-open", context)).toContain(
      "A vote is already open.",
    );
  });

  it("an agreement that ran out or seats that changed", () => {
    expect(words.refusalOf(refused("Expired"), "propose")).toBe("ran-out");
    expect(words.refusalWords("ran-out", context)).toBe(
      "This ran out or the seats changed. Propose it again if it is still needed. Nothing changed.",
    );
    expect(words.refusalOf(refused("SeatsChanged"), "agree")).toBe("ran-out");
    expect(words.refusalOf(refused("AlreadyAgreed"), "agree")).toBe(
      "already-agreed",
    );
  });

  it("a seat election that is not due names the time", () => {
    expect(words.refusalOf(refused("TooEarly"), "open-seats")).toBe(
      "seats-not-due",
    );
    expect(words.refusalWords("seats-not-due", context, NOW)).toContain(
      "The seats are not up for a vote yet",
    );
  });

  it("a helper account, a Council that is off, and a wound-down project", () => {
    expect(words.refusalWords("helper-account", context)).toBe(
      "This account is marked as a helper. A person has to stand.",
    );
    expect(words.refusalOf(refused("NoCouncil"), "hand-over")).toBe(
      "no-council",
    );
    expect(words.refusalOf(refused("WoundDown"), "open-replace")).toBe(
      "wound-down",
    );
  });

  it("an offer to a Council that ran out", () => {
    expect(words.refusalOf(refused("Expired"), "hand-over")).toBe(
      "offer-ran-out",
    );
    expect(words.refusalWords("offer-ran-out", context)).toBe(
      "The offer ran out. Offer the seat again. Nothing changed.",
    );
  });

  it("an error that is not one of these is never guessed", () => {
    expect(words.refusalOf(new Error("the wallet said no"), "vote")).toBeNull();
    expect(words.refusalWords("other", context)).toContain("Nothing changed.");
    expect(words.REFUSAL_FALLBACK).toContain("Nothing changed.");
  });
});

describe("the Council section (6.4)", () => {
  const n = councilRecord("voting");
  const c = council(n);

  it("the heading and the one sentence with the threshold", () => {
    expect(words.COUNCIL_HEADING).toBe("The Council");
    expect(words.councilSummary(c)).toBe(
      "Five accounts run this project together. 3 of them must agree to every action.",
    );
  });

  it("a seat's line: a holder with its date, You on your own, an open seat", () => {
    expect(
      words.seatLine({ seat: c.seats[0]!, index: 0, nameOf, isMe: false }),
    ).toMatch(/^Seat 1: name-7099, since \d+ \w+ \d{4}$/);
    expect(
      words.seatLine({ seat: c.seats[0]!, index: 0, nameOf, isMe: true }),
    ).toContain("Seat 1: You, since ");
    expect(
      words.seatLine({
        seat: { account: null, seatedAt: null },
        index: 2,
        nameOf,
        isMe: false,
      }),
    ).toBe("Seat 3: Open seat");
    expect(words.seatFieldLabel(0)).toBe("Seat 1");
    expect(words.seatFieldLabel(4)).toBe("Seat 5");
  });

  it("the next election says the date, or 'now' while a vote is open", () => {
    expect(
      words.nextElectionLine({ council: c, now: NOW, voteOpen: false }),
    ).toMatch(/^Two seats come up for a vote on /);
    expect(
      words.nextElectionLine({ council: c, now: NOW, voteOpen: true }),
    ).toBe("Two seats come up for a vote now.");
  });

  it("the waiting list's lines and presses", () => {
    expect(words.WAITING_HEADING).toBe("Waiting for your agreement");
    expect(words.agreedLine(1, c.needed)).toBe("1 of 3 have agreed");
    expect(words.AGREE).toBe("Agree");
    expect(words.TAKE_BACK_AGREEMENT).toBe("Take back my agreement");
    expect(words.RAN_OUT).toBe(
      "This ran out; propose it again if it is still needed.",
    );
    expect(words.proposeAskLine(c.needed, c.seats.length)).toBe(
      "This asks the other seats to agree. It runs when 3 of five have agreed.",
    );
  });

  it("the last line, and what the Team tab says when the Council did not read", () => {
    expect(words.councilLastLine(c.seats.length)).toBe(
      "A Council is five accounts. It can do what a founder could do, with the same limits, and nothing more. Taking out stays open.",
    );
    expect(words.COUNCIL_UNREADABLE).toBe(
      "The Council could not be read right now.",
    );
  });
});

describe("the hand-over sheet (6.5)", () => {
  const n = councilRecord("voting");
  const c = council(n);

  it("the two-step sentence and the presses", () => {
    expect(words.HAND_OVER_COUNCIL).toBe("Hand over to a Council");
    expect(words.handOverIntro(c.needed, c.seats.length)).toBe(
      "Once they take the seat, any 3 of the five must agree to what you could do alone. Your Team Shares are not changed. This takes two steps: you offer the seat, then anyone can make the Council.",
    );
    expect(words.OFFER_SEAT).toBe("Offer the seat");
    expect(words.MAKE_COUNCIL).toBe("Make the Council");
  });
});

describe("the words the Council's screens may never use, and the reused constant", () => {
  it("reuses the room's public line word for word", () => {
    expect(words.PUBLIC_LINE).toBe(ROOM_PUBLIC_LINE);
    expect(words.PUBLIC_LINE).toBe("Posts and votes are public.");
  });

  it("no sentence uses a section 6 forbidden word or says 'five people'", () => {
    const n = councilRecord("voting");
    const context = { rule: rule(n), council: council(n), nameOf };
    const sentences = [
      words.COUNCIL_HEADING,
      words.COUNCIL_UNREADABLE,
      words.councilSummary(council(n)),
      words.seatLine({
        seat: council(n).seats[0]!,
        index: 0,
        nameOf,
        isMe: false,
      }),
      words.seatLine({
        seat: { account: null, seatedAt: null },
        index: 0,
        nameOf,
        isMe: false,
      }),
      words.nextElectionLine({ council: council(n), now: NOW, voteOpen: true }),
      words.nextElectionLine({
        council: council(n),
        now: NOW,
        voteOpen: false,
      }),
      words.WAITING_HEADING,
      words.agreedLine(1, 3),
      words.AGREE,
      words.TAKE_BACK_AGREEMENT,
      words.RAN_OUT,
      words.proposeAskLine(3, 5),
      words.councilLastLine(5),
      words.HAND_OVER_COUNCIL,
      words.handOverIntro(3, 5),
      words.OFFER_SEAT,
      words.MAKE_COUNCIL,
      ...(
        [
          "not-eligible-vote",
          "not-eligible-open",
          "not-eligible-stand",
          "vote-ended",
          "voting-not-started",
          "standing-closed",
          "already-stood",
          "bad-members",
          "project-account",
          "holds-seat",
          "no-room",
          "vote-open",
          "cooldown",
          "seats-not-due",
          "already-agreed",
          "ran-out",
          "offer-ran-out",
          "no-council",
          "wound-down",
          "helper-account",
          "other",
        ] as const
      ).map((refusal) => words.refusalWords(refusal, context, NOW)),
    ];
    for (const sentence of sentences)
      for (const forbidden of words.FORBIDDEN_WORDS) {
        const pattern =
          forbidden === "five people"
            ? /five\s+people/i
            : new RegExp(`\\b${forbidden}\\b`, "i");
        expect(pattern.test(sentence), `${forbidden} in "${sentence}"`).toBe(
          false,
        );
      }
    // Each refusal says what happened and what to do next: never a bare "no".
    for (const refusal of [
      "not-eligible-vote",
      "vote-ended",
      "ran-out",
      "offer-ran-out",
      "no-council",
    ] as const) {
      expect(words.refusalWords(refusal, context)).toMatch(
        /Nothing|You can|You already|This ran out|The offer ran out/,
      );
    }
  });
});
