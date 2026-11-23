// The sentence a second signer reads for every call that can wait in a Pair: it names what happens, to whom and how much, and
// a call the app cannot read is "unknown" rather than guessed at.
import {
  announceForfeitCall,
  applyRateCall,
  authoriseAgentCall,
  checkInCall,
  claimGrantCall,
  drawCall,
  grantTeamCall,
  handOverCall,
  proposeRateCall,
  revokeAgentCall,
  runnerForfeitCall,
  setAgentCall,
  setDoorCall,
  setRateCall,
  windDownCall,
} from "@creaton/core/pot/pot-calls.ts";
import { VESTER_ABI } from "@creaton/core/pot/abis.generated.ts";
import { encodeCall } from "@creaton/core/pot/abi-codec.ts";
import { describe, expect, it } from "vitest";
import { numbersFor, D, S } from "../../../tests/helpers/pot-harness";
import { describePotCall, UNKNOWN_WORDS } from "./pair-terms";

const numbers = numbersFor();
const { treasury, vester } = numbers.contracts;
const ANNA = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const name = (a: string) => (a === ANNA ? "Anna" : a);
const words = (call: { to: string; data: string }) =>
  describePotCall(numbers, call.to, call.data, name);

const GUIDE = {
  name: "Translate the guide",
  acceptedBy: "Sam",
  takenBy: "Pat",
};

describe("each call a Pair can hold has a sentence naming what it does", () => {
  it("draw: to whom and how much", () => {
    const t = words(drawCall({ treasury, to: ANNA, amount: 25_500_000n }));
    expect(t.kind).toBe("draw");
    expect(t.words).toBe(
      `Draw 25.50 dollars from the allowance box to Anna (${ANNA}).`,
    );
    expect(t.names).toEqual([ANNA]);
  });
  it("draw that pays an accepted task names the task, so the second signer reads what it is for", () => {
    const call = drawCall({ treasury, to: ANNA, amount: 40_000_000n });
    const one = describePotCall(
      numbers,
      call.to,
      call.data,
      name,
      (payee, raw) => (payee === ANNA && raw === 40_000_000n ? [GUIDE] : []),
    );
    // The sentence is the page's own record, and says who accepted the task and who took it.
    expect(one.words).toBe(
      `Draw 40 dollars from the allowance box to Anna (${ANNA}), the pay for the task "Translate the guide" (accepted by Sam, taken by Pat), as the project's page records it.`,
    );
    const two = describePotCall(numbers, call.to, call.data, name, () => [
      GUIDE,
      { name: "Fix the logo", acceptedBy: "Sam", takenBy: "Lee" },
    ]);
    expect(two.words).toContain(
      'the pay for one of these tasks, as the project\'s page records them: "Translate the guide" (accepted by Sam, taken by Pat); "Fix the logo" (accepted by Sam, taken by Lee).',
    );
    // A draw for nothing owed reads as before.
    const none = describePotCall(numbers, call.to, call.data, name, () => []);
    expect(none.words).toBe(
      `Draw 40 dollars from the allowance box to Anna (${ANNA}).`,
    );
  });
  it("the rate, lowered at once and raised after the wait", () => {
    expect(words(setRateCall(treasury, 500)).words).toBe(
      "Lower the daily allowance to 0.05% of the project's money a day, at once.",
    );
    const raise = words(proposeRateCall(treasury, 1500));
    expect(raise.kind).toBe("rate-raise");
    expect(raise.words).toMatch(
      /Announce a higher daily allowance of 0\.15%.*7 days/,
    );
    expect(words(applyRateCall(treasury)).kind).toBe("rate-apply");
  });
  it("a grant: to whom, how many, and the clock", () => {
    const t = words(
      grantTeamCall({ treasury, member: ANNA, amount: 1_500n * S }),
    );
    expect(t.kind).toBe("grant");
    expect(t.words).toMatch(/Grant 1,500 Team Shares to Anna/);
    expect(t.words).toMatch(/after about 91 days of the team checking in/);
    expect(t.words).toMatch(
      /only the project's money above what backers put in/,
    );
  });
  it("the door, open and shut", () => {
    expect(words(setDoorCall(treasury, false)).words).toMatch(
      /^Close the door to new backing\. People can still take their money out/,
    );
    expect(words(setDoorCall(treasury, true)).words).toBe(
      "Open the door to new backing.",
    );
  });
  it("hand over, with and without the founder leaving", () => {
    const stay = words(
      handOverCall({ treasury, next: ANNA, founderLeaves: false }),
    );
    expect(stay.words).toBe(
      `Offer the seat that runs the project to Anna (${ANNA}).`,
    );
    const leave = words(
      handOverCall({ treasury, next: ANNA, founderLeaves: true }),
    );
    expect(leave.words).toMatch(
      /The founder leaves and gives up the part of their own Team Shares they have not built up/,
    );
  });
  it("handing over to nobody withdraws the offer, and says so", () => {
    const t = words(
      handOverCall({
        treasury,
        next: "0x0000000000000000000000000000000000000000",
        founderLeaves: false,
      }),
    );
    expect(t.kind).toBe("hand-over");
    expect(t.words).toMatch(/^Withdraw the offer of the seat/);
    expect(t.words).not.toMatch(/0x0000/);
    expect(t.names).toEqual([]);
  });
  it("wind down names what it does for good, for this project only", () => {
    const t = words(windDownCall(numbers.launcher, numbers.key));
    expect(t.kind).toBe("wind-down");
    expect(t.words).toMatch(/Wind the project down, for good/);
    expect(t.words).toMatch(/still take their money out/);
    // Another project's key is not this project's call.
    expect(
      words(windDownCall(numbers.launcher, `0x${"ab".repeat(32)}`)).kind,
    ).toBe("unknown");
  });
  it("forfeit, announced by both signers of a Pair: the Treasury's own call, the one a Pair can hold", () => {
    const t = words(runnerForfeitCall(treasury, 3n));
    expect(t.kind).toBe("forfeit");
    expect(t.words).toMatch(
      /grant number 3.*removed after a public notice of 7 days.*keeps what has unlocked/,
    );
  });
  it("a call on the Vester is never one a Pair holds, so it reads as unknown", () => {
    // The Vester's own calls (a member's exit, the Treasury's hand-down) cannot be proposed in a Pair: not confirmed from here.
    expect(words(announceForfeitCall(vester, 3n)).kind).toBe("unknown");
    expect(
      words({
        to: vester,
        data: encodeCall(VESTER_ABI, "announceByRunner", [3n]),
      }).kind,
    ).toBe("unknown");
  });
  it("the helpers: authorise, set limits, switch off", () => {
    expect(words(authoriseAgentCall(treasury, ANNA)).words).toMatch(
      /Let Anna \(0x3c44.*\) act as a helper/,
    );
    const limits = words(
      setAgentCall({
        treasury,
        agent: ANNA,
        usdCap: 25n * D,
        teamCap: 10n * S,
      }),
    );
    expect(limits.words).toMatch(
      /up to 25 dollars from the allowance box and 10 Team Shares a day/,
    );
    expect(words(revokeAgentCall(treasury, ANNA)).words).toMatch(
      /Switch off the helper Anna/,
    );
  });
});

describe("a call the app cannot read is shown as unknown", () => {
  it("a call this app has no sentence for", () => {
    // A check-in is the Pair's own direct call, not something it holds waiting.
    expect(words(checkInCall(treasury, `0x${"00".repeat(32)}`)).kind).toBe(
      "unknown",
    );
    expect(words(claimGrantCall(vester, 1n)).kind).toBe("unknown");
  });
  it("a call to anywhere but this project's own contracts", () => {
    const t = describePotCall(
      numbers,
      "0x00000000000000000000000000000000000000b2",
      drawCall({ treasury, to: ANNA, amount: 1n }).data,
      name,
    );
    expect(t.kind).toBe("unknown");
    expect(t.words).toBe(UNKNOWN_WORDS);
  });
  it("bytes that are no call at all", () => {
    for (const data of ["0x", "0x1234", "0xdeadbeef", `0x${"00".repeat(40)}`])
      expect(describePotCall(numbers, treasury, data, name).kind).toBe(
        "unknown",
      );
  });
  it("a call whose arguments are cut short", () => {
    const full = drawCall({ treasury, to: ANNA, amount: 1n }).data;
    expect(
      describePotCall(numbers, treasury, full.slice(0, 40), name).kind,
    ).toBe("unknown");
  });
});
