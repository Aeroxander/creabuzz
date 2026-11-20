// The four task calls a Pair can hold and the sentence the second signer reads for each: word for word the report's, with the
// numbers from the call and from the network as it is now. A call that names a task the network cannot show, or shows in
// another state than the call works on, is never read out as if it could be confirmed.
import {
  acceptTaskCall,
  announceTaskCall,
  cancelTaskCall,
  rejectTaskCall,
  returnTaskCall,
} from "@creaton/core/pot/pot-calls.ts";
import { describe, expect, it } from "vitest";
import {
  takenNumbers,
  takenRowOf,
  WORKER_WALLET,
} from "../../../tests/helpers/plan-scene";
import { timeText } from "../money/numbers";
import { UNKNOWN_TASK_WORDS } from "../tasks/chain/words";
import { exactDollarsText } from "./pot-words";
import type { ChainTaskNow } from "../tasks/chain/types";
import {
  describePotCall,
  type PairTaskFacts,
  UNKNOWN_WORDS,
} from "./pair-terms";

const numbers = takenNumbers();
const { treasury } = numbers.contracts;
const WHAT = `0x${"7".repeat(64)}`;
const NOW = numbers.asOf.time;
const NAMES: Record<string, string> = { [WORKER_WALLET]: "Pat" };
const name = (a: string) => NAMES[a] ?? a;
const DAY = 86_400;
const NOTICE = {
  noticeSecs: 14 * DAY,
  takeWindowSecs: 7 * DAY,
  dueSecs: 14 * DAY,
};

const taken: ChainTaskNow = takenRowOf(numbers);
const announced: ChainTaskNow = {
  ...taken,
  state: "announced",
  takenBy: null,
  takenAt: null,
  deadline: null,
  setAside: 0n,
};

function facts(over: Partial<PairTaskFacts> = {}): PairTaskFacts {
  return {
    taskFacts: () => taken,
    noticeFor: () => NOTICE,
    now: NOW,
    recordWords: () => null,
    ...over,
  };
}
/** `null` is no facts at all. */
const words = (
  call: { to: string; data: string },
  given: PairTaskFacts | null = facts(),
) =>
  describePotCall(
    numbers,
    call.to,
    call.data,
    name,
    undefined,
    given ?? undefined,
  );

describe("plan a task", () => {
  const call = announceTaskCall({
    treasury,
    what: WHAT,
    payee: WORKER_WALLET,
    maxDollars: 100_000_000n,
    shareBps: 110,
  });

  it("says who is paid, the most, the share, the notice and the dates, word for word", () => {
    const t = words(call);
    expect(t.kind).toBe("announce-task");
    expect(t.words).toBe(
      `Plan a task: pay up to 100 dollars to Pat (${WORKER_WALLET}), at most 1.1% of the project's money. Holders get 14 days notice, so it can be taken from ${timeText(NOW + 14 * DAY)}; if nobody takes it within 7 days it lapses; once taken it is due 14 days later.`,
    );
    expect(t.names).toEqual([WORKER_WALLET]);
  });

  it("adds the second line that the date counts from the confirming, and the task's words when it has them", () => {
    expect(words(call).more).toEqual([
      "The date counts from when you confirm.",
    ]);
    const t = words(
      call,
      facts({
        recordWords: (what) => (what === WHAT ? "Translate the guide" : null),
      }),
    );
    expect(t.more).toEqual([
      "The date counts from when you confirm.",
      "The task: “Translate the guide”",
    ]);
    // The task's words are never part of the sentence.
    expect(t.words).not.toContain("Translate");
  });

  it("with no payee says whoever takes it first", () => {
    const open = announceTaskCall({
      treasury,
      what: WHAT,
      payee: null,
      maxDollars: 5_000_000n,
      shareBps: 1,
    });
    const t = words(open);
    expect(t.words).toContain(
      "pay up to 5 dollars to whoever takes it first, at most 0.01%",
    );
    expect(t.names).toEqual([]);
  });

  it("uses the notice the network gives for this share, on a test network too", () => {
    const t = words(
      call,
      facts({
        noticeFor: () => ({
          noticeSecs: 4_620,
          takeWindowSecs: 2_400,
          dueSecs: 4_800,
        }),
      }),
    );
    expect(t.words).toContain("Holders get 1 hour 17 minutes notice");
    expect(t.words).toContain("within 40 minutes it lapses");
    expect(t.words).toContain("due 1 hour 20 minutes later");
  });

  it("with no notice read it is unknown and never offered", () => {
    for (const given of [null, facts({ noticeFor: () => null })]) {
      const t = words(call, given);
      expect(t.kind).toBe("unknown");
      expect(t.words).toBe(UNKNOWN_TASK_WORDS);
    }
  });
});

describe("pay for a task", () => {
  const call = acceptTaskCall({
    treasury,
    serial: 6n,
    payDollars: 12_500_000n,
  });

  it("names the pay, what is set aside, the task's number and who is paid, word for word", () => {
    const t = words(call);
    expect(t.kind).toBe("accept-task");
    expect(t.words).toBe(
      `Pay 12.50 dollars of the ${exactDollarsText(taken.setAside)} dollars set aside for task 6 to Pat (${WORKER_WALLET}). What is left goes back to the project and to those who took out while it was set aside.`,
    );
    expect(t.names).toEqual([WORKER_WALLET]);
  });

  it("pays all of a set-aside amount with sub-cent digits: the sentence says it exactly, not rounded down", () => {
    const all = acceptTaskCall({
      treasury,
      serial: 6n,
      payDollars: 57_486_851n,
    });
    const t = words(
      all,
      facts({ taskFacts: () => ({ ...taken, setAside: 57_486_851n }) }),
    );
    expect(t.words).toContain(
      "Pay 57.486851 dollars of the 57.486851 dollars set aside",
    );
  });

  it("takes who is paid from the network, never from the call", () => {
    const other = "0x00000000000000000000000000000000000000ee";
    const t = words(
      call,
      facts({ taskFacts: () => ({ ...taken, takenBy: other }) }),
    );
    expect(t.words).toContain(`to ${other} (${other})`);
  });

  it("with no facts for the task it is unknown, with the one sentence for that", () => {
    for (const given of [null, facts({ taskFacts: () => null })]) {
      const t = words(call, given);
      expect(t.kind).toBe("unknown");
      expect(t.words).toBe(
        "This is about a task whose details could not be read from the network, so it cannot be confirmed from here. Try again in a moment.",
      );
    }
  });

  it("for a task that is no longer taken it says so and cannot be confirmed", () => {
    const t = words(
      call,
      facts({ taskFacts: () => ({ ...taken, state: "paid" }) }),
    );
    expect(t.kind).toBe("unknown");
    expect(t.words).toBe(
      "This call is about task 6, which has changed since it was asked: it is now already paid. It cannot be confirmed any more. Whoever asked can withdraw it.",
    );
  });
});

describe("a call the contract would refuse because the task is past its end", () => {
  it("a taken task past its deadline is not offered for payment", () => {
    const pay = acceptTaskCall({
      treasury,
      serial: 6n,
      payDollars: 12_500_000n,
    });
    const late = words(
      pay,
      facts({
        now: (taken.deadline ?? taken.expiresAt) + 1,
        taskFacts: () => taken,
      }),
    );
    expect(late.kind).toBe("unknown");
    expect(late.words).toMatch(/which has changed since it was asked/);
    const punctual = words(
      pay,
      facts({
        now: (taken.deadline ?? taken.expiresAt) - 1,
        taskFacts: () => taken,
      }),
    );
    expect(punctual.kind).toBe("accept-task");
  });
});

describe("send a task's money back and withdraw a plan", () => {
  it("send back: nobody is paid", () => {
    const t = words(rejectTaskCall({ treasury, serial: 6n }));
    expect(t.kind).toBe("reject-task");
    expect(t.words).toBe("Send task 6's money back. Nobody is paid.");
  });

  it("withdraw: it was not taken, so no money moves", () => {
    const t = words(
      cancelTaskCall({ treasury, serial: 7n }),
      facts({ taskFacts: () => announced }),
    );
    expect(t.kind).toBe("cancel-task");
    expect(t.words).toBe(
      "Withdraw task 7. It was not taken, so no money moves.",
    );
  });

  it("the task's words are a line under the sentence when the task ties to a record here", () => {
    const t = words(
      rejectTaskCall({ treasury, serial: 6n }),
      facts({
        recordWords: (what) =>
          what === taken.what ? "Translate the guide" : null,
      }),
    );
    expect(t.more).toEqual(["The task: “Translate the guide”"]);
  });

  it("withdraw for a task that has been taken, and send back for one that has not, are unknown", () => {
    expect(words(cancelTaskCall({ treasury, serial: 6n })).kind).toBe(
      "unknown",
    );
    const t = words(
      rejectTaskCall({ treasury, serial: 7n }),
      facts({ taskFacts: () => announced }),
    );
    expect(t.kind).toBe("unknown");
    expect(t.words).toMatch(
      /has changed since it was asked: it is now planned, and it can be taken/,
    );
  });

  it("without facts neither is read out", () => {
    expect(words(rejectTaskCall({ treasury, serial: 6n }), null).words).toBe(
      UNKNOWN_TASK_WORDS,
    );
    expect(words(cancelTaskCall({ treasury, serial: 7n }), null).words).toBe(
      UNKNOWN_TASK_WORDS,
    );
  });
});

describe("what the app cannot read", () => {
  it("a task call to anywhere but the project's Treasury is unknown", () => {
    const call = rejectTaskCall({ treasury, serial: 6n });
    const t = describePotCall(
      numbers,
      "0x00000000000000000000000000000000000000ab",
      call.data,
      name,
      undefined,
      facts(),
    );
    expect(t.kind).toBe("unknown");
    expect(t.words).toBe(UNKNOWN_WORDS);
  });

  it("a call on the Treasury that is not one of the calls with a sentence is unknown, with no kind sentence", () => {
    const t = words(returnTaskCall({ treasury, serial: 6n }));
    expect(t.kind).toBe("unknown");
    expect(t.words).toBe(UNKNOWN_WORDS);
  });

  it("call data that cannot be decoded is unknown", () => {
    const t = describePotCall(
      numbers,
      treasury,
      "0xdeadbeef",
      name,
      undefined,
      facts(),
    );
    expect(t.kind).toBe("unknown");
    expect(t.words).toBe(UNKNOWN_WORDS);
  });
});
