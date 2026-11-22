// The vote card (`docs/next-version/COUNCIL-PLAN.md` section 6.2): shown only with an open ballot, its title by kind, the
// state line, one row per choice with the percent and the candidate's own text, the count line built from the rule, the
// presses an eligible holder gets, the planned change from the moment voting ends, and the read-only card a visitor or a
// holder who parked later reads. Records are the milestone 9 test records, put through the app's real parser.
import {
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOW,
  DAY,
  LIST,
  ACCOUNTS,
  HASH,
  councilPlain,
  councilRecord,
  timesFrom,
} from "../../../tests/helpers/council-v2-parse";
import {
  installWallet,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import { VoteCard } from "./VoteCard";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const COORDINATE = `37001:${"b".repeat(64)}:demo`;
const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
const nameOf = (address: string) => short(address);
const ME = "0x1111111111111111111111111111111111111111";

/** The card, as the Money tab draws it for a person. */
function show(
  record: ReturnType<typeof councilRecord>,
  options: {
    address?: string | null;
    holds?: boolean;
    parked?: bigint;
    now?: number;
  } = {},
) {
  return wrap(
    <VoteCard
      address={options.address === undefined ? ME : options.address}
      holds={options.holds ?? true}
      nameOf={nameOf}
      now={options.now ?? NOW}
      numbers={record}
      parked={options.parked ?? 1_000n}
      projectCoordinate={COORDINATE}
    />,
  );
}

/** Answer `HolderVote.ballotOf(account)` in the page's wallet, so the card can mark the person's own choice. */
function answerBallot(input: { id: number; option: number; weight: bigint }) {
  const eth = (window as unknown as { ethereum: { request: unknown } })
    .ethereum as { request: (args: unknown) => Promise<unknown> };
  const original = eth.request.bind(eth);
  eth.request = async (args: unknown) => {
    const call = args as { method?: string; params?: { data?: string }[] };
    if (call.method === "eth_call") {
      const data = String(call.params?.[0]?.data ?? "");
      if (data.startsWith(selectorOf("ballotOf(address)")))
        return encodeParameters(
          ["uint32", "uint8", "uint256", "uint256"],
          [BigInt(input.id), BigInt(input.option), input.weight, input.weight],
        );
    }
    return original(args);
  };
}

/** One candidacy record the project carries, as the server stores it. */
function candidacy(input: {
  id: string;
  text: string;
  proposer: string;
  candidates: string[];
}) {
  return {
    id: input.id,
    pubkey: "c".repeat(64),
    kind: 47003,
    created_at: NOW,
    tags: [
      ["a", COORDINATE],
      ["candidacy", "3"],
      ["t", `vote:${"0".repeat(64)}:3`],
      ["proposer", input.proposer],
      ...input.candidates.map((account) => ["candidate", account]),
      ["expiration", String(NOW + DAY)],
    ],
    content: JSON.stringify({ v: 1, text: input.text }),
  };
}

beforeEach(() => {
  installWallet({ account: ME });
  serve([]);
});
afterEach(cleanup);

describe("the vote card shows only where there is a ballot", () => {
  it("draws nothing on a record with no vote (and nothing new on an older one)", () => {
    show(councilPlain());
    expect(screen.queryByTestId("vote-card")).toBeNull();
  });

  it("draws nothing for a ballot that was carried out or let go", () => {
    show(councilRecord("carried-out"));
    expect(screen.queryByTestId("vote-card")).toBeNull();
    cleanup();
    show(councilRecord("lapsed"));
    expect(screen.queryByTestId("vote-card")).toBeNull();
  });

  it("a result that changed nothing keeps its card for three days and then is gone", () => {
    // Kept: the ballot ended two days ago, inside the three days the card stays.
    const recent = councilRecord("kept", (r) => {
      r.vote.open = { ...r.vote.open, ...timesFrom(NOW - 5 * DAY) };
    });
    show(recent);
    expect(screen.getByTestId("vote-state-ended").textContent).toBe(
      "The vote ended. Nothing changes.",
    );
    cleanup();
    // The same card six days after the vote ended is gone.
    const old = councilRecord("kept");
    show(old);
    expect(screen.queryByTestId("vote-card")).toBeNull();
  });
});

describe("the replace card while the names are put forward", () => {
  it("says what is being chosen and until when, and offers an eligible holder the list press", () => {
    show(councilRecord("standing"));
    expect(screen.getByRole("heading").textContent).toBe(
      "A vote on who runs this project",
    );
    expect(screen.getByTestId("vote-intro").textContent).toBe(
      "Holders are choosing between keeping things as they are and a new Council of five accounts.",
    );
    expect(screen.getByTestId("vote-state-standing").textContent).toMatch(
      /^Anyone with parked Shares can put forward a list of five accounts until .*\. Voting starts then\.$/,
    );
    expect(screen.getByTestId("vote-stand").textContent).toBe(
      "Put forward a list",
    );
    // The public line is where a person can stand.
    expect(screen.getByTestId("vote-public").textContent).toBe(
      "Posts and votes are public.",
    );
    // The last line is on every replace card.
    expect(screen.getByTestId("vote-last").textContent).toBe(
      "A vote only changes who runs this project. Taking out stays open: if you will be away, you can take your money out first.",
    );
  });
});

describe("the voting card", () => {
  it("has a row per choice with the plain percent, the count line from the rule and one distinct press each", () => {
    show(councilRecord("voting"));
    const rows = screen.getAllByTestId(/^vote-row-/);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Keep things as they are");
    expect(rows[0]?.textContent).toContain("75%");
    expect(rows[1]?.textContent).toContain("List 1:");
    expect(rows[1]?.textContent).toContain("25%");
    // No signed text matches the chain's hash here, so the row says so plainly.
    expect(rows[1]?.textContent).toContain("No text");
    expect(rows[1]?.textContent).toContain("Put forward by");
    expect(rows[1]?.textContent).toContain(
      "Nobody on a list has to agree to it.",
    );
    // The count line: the cast part, the floor from the rule, and how a list wins.
    expect(screen.getByTestId("vote-count").textContent).toBe(
      "40% of Shares have voted. The vote counts when at least 33% do, and a list wins with more than half of those.",
    );
    // One press per row, each with its own name.
    const presses = screen.getAllByTestId(/^vote-press-/);
    expect(presses).toHaveLength(2);
    expect(presses[0]?.getAttribute("aria-label")).toBe(
      "Vote to keep things as they are",
    );
    expect(presses[1]?.getAttribute("aria-label")).toBe(
      `Vote for List 1: ${LIST.map(short).join(", ")}`,
    );
    expect(presses[1]?.textContent).toBe("Vote for this");
    expect(screen.getByTestId("vote-last")).toBeTruthy();
  });

  it("shows the candidate's own text only when the signed record is the one the chain stored", async () => {
    serve([
      candidacy({
        id: HASH,
        text: "I would keep the marketplace open on Fridays.",
        proposer: ACCOUNTS[0] as string,
        candidates: LIST,
      }),
    ]);
    show(councilRecord("voting"));
    expect(
      await screen.findByText("I would keep the marketplace open on Fridays."),
    ).toBeTruthy();
    cleanup();
    // The same id, but naming other accounts: never shown (the chain stored another text).
    serve([
      candidacy({
        id: HASH,
        text: "A text the chain did not store.",
        proposer: ACCOUNTS[0] as string,
        candidates: ACCOUNTS,
      }),
    ]);
    show(councilRecord("voting"));
    expect(screen.getByTestId("vote-row-1").textContent).toContain("No text");
    expect(screen.queryByText("A text the chain did not store.")).toBeNull();
  });

  it("marks the person's own choice from the chain's answer for them", async () => {
    answerBallot({ id: 3, option: 1, weight: 1_000n });
    show(councilRecord("voting"));
    expect(await screen.findByTestId("vote-yours")).toBeTruthy();
    expect(screen.getByTestId("vote-row-1").textContent).toContain("Your vote");
  });

  it("marks a candidate's own row", () => {
    show(councilRecord("voting"), { address: LIST[0] as string });
    expect(screen.getByTestId("vote-standing").textContent).toBe(
      "You are standing.",
    );
  });
});

describe("the card after the vote", () => {
  it("shows the planned change from voteEnd, whether or not anyone recorded it", () => {
    show(councilRecord("moved"));
    const line = screen.getByTestId("vote-state-waiting").textContent ?? "";
    expect(line).toMatch(
      new RegExp(
        `^Holders voted to change who runs this project\\. On .+ ${LIST.map(short).join(", ")} take over from the Council\\. You can take your money out before then\\. Taking out stays open\\.$`,
      ),
    );
    expect(screen.queryByTestId("vote-press-1")).toBeNull();
  });

  it("says a seat election's result, and what happens when nobody wins", () => {
    show(councilRecord("seated"));
    expect(screen.getByTestId("vote-state-waiting").textContent).toMatch(
      new RegExp(
        `^The vote ended\\. ${short(ACCOUNTS[0] as string)} and ${short(ACCOUNTS[1] as string)} take their seats on .+\\. You can take your money out before then\\.$`,
      ),
    );
    cleanup();
    show(
      councilRecord("unchanged", (r) => {
        r.vote.open = { ...r.vote.open, ...timesFrom(NOW - 5 * DAY) };
      }),
    );
    expect(screen.getByTestId("vote-state-ended").textContent).toBe(
      "The vote ended. The seats stay as they are.",
    );
  });
});

describe("who reads the card, and what they can press", () => {
  it("a visitor reads it with the plan's sentence and no press at all", () => {
    show(councilRecord("voting"), { address: null, holds: false });
    expect(screen.getByTestId("vote-explain").textContent).toBe(
      "Only people who back this project can vote.",
    );
    expect(screen.queryAllByTestId(/^vote-press-/)).toHaveLength(0);
    expect(screen.queryByTestId("vote-public")).toBeNull();
  });

  it("a holder whose Shares were not parked before it opened reads it with no vote press", () => {
    show(councilRecord("voting"), { holds: true, parked: 0n });
    expect(screen.getByTestId("vote-explain").textContent).toBe(
      "You can't vote in this one. Only Shares parked before it opened count. You can take your money out any time.",
    );
    expect(screen.queryAllByTestId(/^vote-press-/)).toHaveLength(0);
  });

  it("a record older than the server promises says so instead of a state line", () => {
    const stale = councilRecord("voting", (r) => {
      r.builtAt -= 2 * DAY;
    });
    show(stale, { now: NOW });
    expect(screen.getByTestId("vote-stale").textContent).toBe(
      "These numbers are older than the server promises, so nothing is said here about where the vote stands now.",
    );
    expect(screen.queryByTestId("vote-state-voting")).toBeNull();
    expect(screen.queryAllByTestId(/^vote-press-/)).toHaveLength(0);
  });

  it("says what happened when the network refuses the vote, in plain words", async () => {
    // The wallet refuses the call: the card never shows the refusal's own name.
    show(councilRecord("voting"));
    const press = screen.getByTestId("vote-press-1");
    const eth = (window as unknown as { ethereum: { request: unknown } })
      .ethereum as { request: (args: unknown) => Promise<unknown> };
    eth.request = async () => {
      throw new Error("execution reverted: NotEligible");
    };
    fireEvent.click(press);
    const problem = await screen.findByTestId("vote-problem");
    expect(problem.textContent).toBe(
      "You can't vote in this one. Only Shares parked before it opened count. You can take your money out any time.",
    );
    expect(problem.textContent).not.toMatch(/NotEligible/);
  });
});

describe("the seat election card", () => {
  it("names the seats and says how they stay", () => {
    show(councilRecord("seats"));
    expect(screen.getByRole("heading").textContent).toBe(
      "Two seats on the Council are up",
    );
    const rows = screen.getAllByTestId(/^vote-row-/);
    expect(rows[0]?.textContent).toContain("Keep the two seats as they are");
    expect(rows[1]?.textContent).toContain(short(ACCOUNTS[0] as string));
    expect(rows[1]?.textContent).toContain("50%");
    expect(screen.getByTestId("vote-stay").textContent).toBe(
      "Seats stay as they are if too few Shares vote, or if nobody gets more votes than keeping them.",
    );
    expect(screen.getAllByTestId(/^vote-press-/)).toHaveLength(3);
  });
});
