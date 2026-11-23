// The planned-change sentence on the Back sheet (COUNCIL-PLAN.md section 6.1): anyone who backs after a result that moved
// who runs the project reads it before they put money in — from the vote's end, and while the change waits.
import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  councilRecord,
  NOW,
} from "../../../tests/helpers/council-v2-parse";
import { backPlannedChange } from "./BackSheet";

const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

describe("the Back sheet's planned change", () => {
  it("says who takes over, when, and that taking out stays open, from voteEnd on", () => {
    const line = backPlannedChange(councilRecord("moved"), NOW);
    expect(line).toMatch(
      /^Holders voted to change who runs this project\. On .+ take over from the Council\. You can take your money out before then\. Taking out stays open\.$/,
    );
    // The same list the card names, in the list's own seat order.
    expect(line).toContain("0x976e…0aa9");
  });

  it("says a seat election's result the same way", () => {
    const line = backPlannedChange(councilRecord("seated"), NOW) ?? "";
    expect(line).toMatch(
      new RegExp(
        `^The vote ended\\. ${short(ACCOUNTS[0] as string)} and ${short(ACCOUNTS[1] as string)} take their seats on .+\\. You can take your money out before then\\.$`,
      ),
    );
  });

  it("names an account the way the vote card does when a name is known", () => {
    // The same runner reads the same on the Back sheet and on the vote's sentences: a name, with the short address
    // beside it (the account is what the network sees).
    const names: Record<string, string> = {
      [(ACCOUNTS[0] as string).toLowerCase()]: "Ada",
    };
    const line =
      backPlannedChange(
        councilRecord("seated"),
        NOW,
        (account) => names[account.toLowerCase()] ?? short(account),
      ) ?? "";
    expect(line).toContain("Ada (0x7099…79c8)");
  });

  it("says nothing while the vote runs, and nothing about a result that changed nothing", () => {
    expect(backPlannedChange(councilRecord("voting"), NOW)).toBeNull();
    expect(backPlannedChange(councilRecord("kept"), NOW)).toBeNull();
    expect(backPlannedChange(councilRecord("standing"), NOW)).toBeNull();
  });
});
