// The room's sentences: the fixed lines are exactly as the plan says, every refusal the server's room rule gives is said in
// plain words with what to do next, and no word of the protocol reaches a person.
import { describe, expect, it } from "vitest";
import {
  KIND_LINE,
  leftText,
  NEED_LINK,
  NOT_READY,
  PERKS_NOT_MONEY,
  PUBLIC_LINE,
  READ_LINE,
  roomRefusal,
} from "./room-words";

describe("the fixed lines", () => {
  it("are word for word", () => {
    expect(PUBLIC_LINE).toBe("Posts and votes are public.");
    expect(READ_LINE).toBe(
      "Anyone can read this room. Only people who back the project can write here.",
    );
    expect(KIND_LINE).toBe("The team can remove posts. Be kind.");
    expect(PERKS_NOT_MONEY).toBe(
      "These are the team's own words. They are not money and not a promise of a return.",
    );
  });
});

describe("the server's refusals, in plain words", () => {
  const cases: [
    string,
    RegExp,
    { catchingUp?: boolean; needsLink?: boolean },
  ][] = [
    [
      "restricted: rooms are not switched on on this server",
      /not switched on/,
      {},
    ],
    ["invalid: this project is not here", /not here/, {}],
    [
      "invalid: a room post names its project and its room",
      /Reload the page/,
      {},
    ],
    [
      "invalid: the room is for text; leave out pictures and files",
      /text.*pictures and files/,
      {},
    ],
    ["invalid: a room post is at most 2000 characters", /2,000 characters/, {}],
    [
      "retry: the server has not read this project yet; try again in a minute",
      /^Not ready yet\. Try again in a minute\.$/,
      { catchingUp: true },
    ],
    [
      "restricted: link your wallet to your account first, so the server can see that you back this project",
      /needs this account confirmed/,
      { needsLink: true },
    ],
    [
      "restricted: only people who back this project can write in its room. If you just backed it, wait about a minute and try again",
      /^Not ready yet\. Try again in a minute\.$/,
      { catchingUp: true },
    ],
    [
      "restricted: the team has stopped you writing in this room for now",
      /take your money out any time/,
      {},
    ],
    [
      "restricted: you are writing too fast; try again in a few minutes",
      /^You are writing too fast\. Try again in a few minutes\.$/,
      {},
    ],
    [
      "restricted: too many accounts write from this wallet",
      /^Too many accounts write from this wallet\.$/,
      {},
    ],
    [
      "invalid: a reply belongs in the same room as the post it answers",
      /^A reply belongs in the same room as the post it answers\.$/,
      {},
    ],
  ];
  for (const [said, words, flags] of cases)
    it(said, () => {
      const out = roomRefusal(said);
      expect(out.words).toMatch(words);
      expect(out.catchingUp).toBe(flags.catchingUp ?? false);
      expect(out.needsLink).toBe(flags.needsLink ?? false);
      // Said the same whatever prefix the server puts first.
      expect(roomRefusal(said.replace(/^[a-z-]+: /, "x: ")).words).toBe(
        out.words,
      );
      expect(out.words).not.toMatch(/restricted|invalid|kind|nostr|relay/i);
    });

  it("says a ban, a request limit and a server fault in the words the app already has, and anything else as a failure", () => {
    expect(
      roomRefusal("restricted: you are timed out until 1893456000").words,
    ).toMatch(/muted everywhere/);
    expect(
      roomRefusal("rate-limited: quota exceeded; retry in 3s").words,
    ).toMatch(/3 seconds/);
    expect(roomRefusal("error: db error: gone").words).toMatch(
      /server couldn't/,
    );
    expect(roomRefusal("what").words).toBe(
      "Your post was not sent. Try again.",
    );
    expect(NEED_LINK).toMatch(/confirmed/);
    expect(NOT_READY).toMatch(/minute/);
  });
});

describe("a stretch of time", () => {
  it("is said in the largest plain unit, at least a minute", () => {
    expect(leftText(5)).toBe("1 minute");
    expect(leftText(125)).toBe("3 minutes");
    expect(leftText(3600)).toBe("1 hour");
    expect(leftText(5 * 3600)).toBe("5 hours");
    expect(leftText(3 * 86_400)).toBe("3 days");
  });
});
