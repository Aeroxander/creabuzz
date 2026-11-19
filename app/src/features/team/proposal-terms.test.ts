// The second signer is asked to Confirm a waiting call: it names its terms (a round's price, an auction's starting
// price), and says so when they are not the usual ones, since they cannot be changed once it is open.
import { describe, expect, it } from "vitest";
import { describeProposal } from "./pair";
import { openAuctionData, openRoundData } from "./team-calls";

const KEY = `0x${"11".repeat(32)}`;
const nameOf = (a: string) => a;
const Q96 = 2n ** 96n;

describe("a waiting call says what it will do, terms included", () => {
  it("a round at 20 Shares a dollar reads differently from a round at 3,000", () => {
    const cheap = describeProposal(
      openRoundData(KEY, 3_000_000_000_000_000n),
      nameOf,
    );
    const dear = describeProposal(
      openRoundData(KEY, 20_000_000_000_000n),
      nameOf,
    );
    expect(dear.words).not.toBe(cheap.words);
  });

  it("an auction starting at 0.05 dollars a Share reads differently from one at 0.0004", () => {
    const low = describeProposal(
      openAuctionData(KEY, (4n * Q96) / 10_000_000_000_000_000n),
      nameOf,
    );
    const high = describeProposal(
      openAuctionData(KEY, (50_000n * Q96) / 10n ** 18n),
      nameOf,
    );
    expect(high.words).not.toBe(low.words);
  });
});
