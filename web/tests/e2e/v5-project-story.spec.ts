import { expect, test, type Page } from "@playwright/test";
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import {
  combineNodeBytes,
  scoreLeafBytes,
} from "@creaton/core/launchpad/trust-score.ts";
import { finalizeEvent } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";
import { createMockRelay } from "./mock-relay";

/**
 * The project's front page as one story: ONE next action, whose turn it is, and
 * the date its window closes in words that name the window — never "it changes
 * by itself", because a clock closes a window and never runs a contract. The
 * rest of the queue stays reachable and nothing repeats the lead; a failed read
 * is said out loud instead of "nothing is waiting"; a person who is not
 * connected gets no prompts that assume a wallet.
 *
 * The chain is a stub: this spec answers the exact calls the project's locks,
 * decisions and work reads make (same JSON-RPC shape) with one challenge-locked
 * state — milestone 1 published, its objection window open. What is stubbed:
 * the relay (it serves the launch records) and the node (a recorded state, the
 * way Anvil answers); what is real is every rendered surface this state feeds —
 * the page computes its words, its ranking and its dates from the answers.
 *
 * Skipped when no explicit chain endpoint is set, so the real-chain suites are
 * never mistaken for the stubbed one:
 *
 *   E2E_STUB_RPC=1 → tests/e2e/v5-project-story.spec.ts
 */

test.skip(
  !process.env.E2E_STUB_RPC,
  "set E2E_STUB_RPC (this spec drives a stubbed chain)",
);

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

// ── A real published score root, signed the way an operator signs one ────────
// Two publishers' records for one program:epoch: same replaceable coordinate,
// two signatures, two roots. Their bundle answers must never cross.
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;

const scoreProgram = "member-score";
const scoreEpoch = "1";

/** One publisher's bundle for its own root: two scores, proofs that rebuild it. */
function publisherBundle(
  first: number,
  second: number,
): {
  root: string;
  proofs: Record<string, { score: number; proof: string[] }>;
} {
  const memberA = `0x${"11".repeat(20)}`;
  const memberB = `0x${"22".repeat(20)}`;
  const leafA = scoreLeafBytes(memberA, first);
  const leafB = scoreLeafBytes(memberB, second);
  return {
    root: hex(combineNodeBytes(leafA, leafB)),
    proofs: {
      [memberA]: { score: first, proof: [hex(leafB)] },
      [memberB]: { score: second, proof: [hex(leafA)] },
    },
  };
}

const bundleA = publisherBundle(50, 51);
const bundleB = publisherBundle(60, 61);

/** Sign one publisher's score-root record (kind 37006) the real way. */
const scoreRootEvent = (
  secretByte: number,
  bundle: { root: string; proofs: unknown },
  url: string,
) => {
  const secret = new Uint8Array(32).fill(secretByte);
  return finalizeEvent(
    {
      kind: 37006,
      created_at: NOW,
      tags: [["d", `${scoreProgram}:${scoreEpoch}`]],
      content: JSON.stringify({
        program: scoreProgram,
        root: bundle.root,
        epoch: scoreEpoch,
        indexerUrl: url,
      }),
    },
    secret,
  );
};

const recordA = scoreRootEvent(
  7,
  bundleA,
  "https://proofs.local/epoch-1-a.json",
);
const recordB = scoreRootEvent(
  9,
  bundleB,
  "https://proofs.local/epoch-1-b.json",
);

// ── the recorded state ────────────────────────────────────────────────────────
const DAO = `0x${"11".repeat(20)}`;
const SHARES = `0x${"22".repeat(20)}`;
const LOCK = `0x${"33".repeat(20)}`;
const POLICY = `0x${"44".repeat(20)}`;
const FACTORY = `0x${"55".repeat(20)}`;
const CURRENCY = `0x${"66".repeat(20)}`;
const GATE = `0x${"99".repeat(20)}`;
const FOUNDER = `0x${"77".repeat(20)}`;
const HOLDER = `0x${"88".repeat(20)}`;
const ZERO = `0x${"0".repeat(40)}`;
/** The Shares the record plans for the DAO, and the part of them the team's milestones hold back (25%). */
const SUPPLY = 20_000_000n * 10n ** 18n;
const THE_TEAM = (SUPPLY * 25n) / 100n;
/** What the raise brought in, in the sale currency's own units (USDC has 6 decimals). */
const RAISED = 149_999_999_998n;
/** The Shares the connected holder bought: a twentieth of them all. */
const HOLDER_SHARES = SUPPLY / 20n;

const word = (value: bigint | number) =>
  BigInt(value).toString(16).padStart(64, "0");
const wordAddr = (address: string) =>
  address.toLowerCase().slice(2).padStart(64, "0");
const hashWord = (hex: string) => hex.toLowerCase().padStart(64, "0");

const windowEnds = NOW + 6 * DAY;
const BOND = 1_499_999_999_998n;

/** The eight fields of the lock's per-milestone tuple, in the order the reply words them. */
const milestoneState = (args: {
  phase: number;
  attempts: number;
  submitter: string | null;
  evidence: string | null;
  windowEnds: number;
  unlockedAt: number;
  bond: bigint | number;
}) =>
  [
    word(args.phase),
    word(0),
    word(args.attempts),
    wordAddr(args.submitter ?? `0x${"0".repeat(40)}`),
    hashWord(args.evidence ? "ab".repeat(32) : "00".repeat(32)),
    word(args.windowEnds),
    word(args.unlockedAt),
    word(args.bond),
  ].join("");

/** The objection reply, all zeros — nobody has raised one yet. */
const NO_OBJECTION = "0".repeat(64 * 9);

const answers: Record<string, string> = {};
/** The key a read is answered under: its contract and its calldata, lower case, without the `0x`. */
const callKey = (to: string, data: string) =>
  `${to.toLowerCase()}|${data.toLowerCase().replace(/^0x/, "")}`;
/** An answer for every call of this function, whatever its arguments. */
const answer = (to: string, signature: string, reply: string) => {
  answers[callKey(to, selectorOf(signature))] = reply;
};
/** Same, for a call with arguments: the reply may differ per argument. */
const answerArgs = (
  to: string,
  signature: string,
  args: (bigint | string | number)[],
  reply: string,
) => {
  const words = args
    .map((arg) => (typeof arg === "string" ? wordAddr(arg) : word(arg)))
    .join("");
  answers[callKey(to, `${selectorOf(signature)}${words}`)] = reply;
};
const answerCall = (
  to: string,
  signature: string,
  arg: bigint | string | number,
  reply: string,
) => answerArgs(to, signature, [arg], reply);

// The DAO names its contracts.
answer(DAO, "shares()", `0x${wordAddr(SHARES)}`);
answer(DAO, "votingWeight()", `0x${wordAddr(POLICY)}`);
// The Shares name their lock; the lock names the DAO and its terms.
answer(SHARES, "lockGuard()", `0x${wordAddr(LOCK)}`);
answer(LOCK, "milestoneCount()", `0x${word(2)}`);
answer(LOCK, "dao()", `0x${wordAddr(DAO)}`);
answer(LOCK, "window()", `0x${word(7 * DAY)}`);
answer(LOCK, "votePeriod()", `0x${word(21 * DAY)}`);
answer(LOCK, "clawback()", `0x${word(30 * DAY)}`);
answer(LOCK, "minRejectBps()", `0x${word(5000)}`);
answer(LOCK, "earliestBlock()", `0x${word(0)}`);
answer(LOCK, "bondToken()", `0x${wordAddr(CURRENCY)}`);
answer(LOCK, "bond()", `0x${word(BOND)}`);
answer(LOCK, "deposit()", `0x${word(BOND / 10n)}`);
// The team of this lock: one member. Everyone else is a holder to object with.
answer(LOCK, "team()", `0x${word(32)}${word(1)}${wordAddr(FOUNDER)}`);
answer(LOCK, "shareOf(uint256)", `0x${word(5000)}`);
// Milestone 0 is published and open to objections; milestone 1 is not yet. The
// reply is per milestone, so each call names its index.
for (const index of [0, 1]) {
  answerCall(
    LOCK,
    "milestone(uint256)",
    index,
    `0x${
      index === 0
        ? milestoneState({
            phase: 1,
            attempts: 0,
            submitter: FOUNDER,
            evidence: "ab".repeat(32),
            windowEnds,
            unlockedAt: 0,
            bond: BOND,
          })
        : milestoneState({
            phase: 0,
            attempts: 0,
            submitter: null,
            evidence: null,
            windowEnds: 0,
            unlockedAt: 0,
            bond: 0,
          })
    }`,
  );
  answerCall(LOCK, "checkOf(uint256)", index, `0x${hashWord("cd".repeat(32))}`);
  answerCall(LOCK, "shareOf(uint256)", index, `0x${word(5000)}`);
  answerCall(LOCK, "windowFor(uint256)", index, `0x${word(7 * DAY)}`);
  answerCall(LOCK, "objection(uint256)", index, `0x${NO_OBJECTION}`);
}
answerCall(LOCK, "lockedOf(address)", FOUNDER, `0x${word(THE_TEAM)}`);
// How the connected wallet's vote would count on each milestone: the holder's
// Shares count, the team's do not, and neither has voted yet.
for (const index of [0, 1]) {
  answerArgs(
    LOCK,
    "voteWeight(uint256,address)",
    [index, HOLDER],
    `0x${word(HOLDER_SHARES)}`,
  );
  answerArgs(
    LOCK,
    "voteWeight(uint256,address)",
    [index, FOUNDER],
    `0x${word(0)}`,
  );
  answerArgs(
    LOCK,
    "hasVoted(uint256,address)",
    [index, HOLDER],
    `0x${word(0)}`,
  );
  answerArgs(
    LOCK,
    "hasVoted(uint256,address)",
    [index, FOUNDER],
    `0x${word(0)}`,
  );
}
answerCall(LOCK, "isTeam(address)", HOLDER, `0x${word(0)}`);
answerCall(LOCK, "isTeam(address)", FOUNDER, `0x${word(1)}`);
// Decisions: the DAO has opened none.
answer(POLICY, "mandateFactory()", `0x${wordAddr(FACTORY)}`);
answer(DAO, "proposalThreshold()", `0x${word(1)}`);
answer(DAO, "getProposalCount()", `0x${word(0)}`);
// The holder reads the decisions too: their voting capacity is an answer.
answerCall(POLICY, "capacity(address)", HOLDER, `0x${word(HOLDER_SHARES)}`);
// The team votes with its locked Shares from the first day.
answerCall(POLICY, "capacity(address)", FOUNDER, `0x${word(THE_TEAM)}`);
// Work: the factory has made no mandates for this DAO.
answer(FACTORY, "milestoneMandate(address)", `0x${wordAddr(ZERO)}`);

// ── the three numbers the page opens with, and what leaving is worth ─────────
// Every Share the record planned, and who holds them: the team's tranche is
// locked behind the milestones, the holder's came from the sale.
answer(SHARES, "totalSupply()", `0x${word(SUPPLY)}`);
answerCall(SHARES, "balanceOf(address)", HOLDER, `0x${word(HOLDER_SHARES)}`);
answerCall(SHARES, "balanceOf(address)", FOUNDER, `0x${word(THE_TEAM)}`);
answerCall(SHARES, "balanceOf(address)", DAO, `0x${word(0)}`);
answer(SHARES, "awardsOnly()", `0x${word(0)}`);
// The raise's money is in the treasury; no separate Loot token exists.
answerCall(CURRENCY, "balanceOf(address)", DAO, `0x${word(RAISED)}`);
answerCall(CURRENCY, "balanceOf(address)", SHARES, `0x${word(0)}`);
answer(DAO, "loot()", `0x${wordAddr(ZERO)}`);
// Leaving is permanent in a DAO made after the switch was removed, and members
// can still leave with their part of the treasury.
answer(DAO, "leaving()", `0x${word(1)}`);
answer(DAO, "ragequittable()", `0x${word(1)}`);
// What a decision waits: the DAO's delay, then the lane's review.
answer(DAO, "timelockDelay()", `0x${word(DAY)}`);
// The DAO's own turnout and approval bars, which raise a lane's and never lower it.
answer(DAO, "quorumBps()", `0x${word(2000)}`);
answer(DAO, "quorumAbsolute()", `0x${word(0)}`);
answer(DAO, "minYesVotesAbsolute()", `0x${word(0)}`);
/** `lanes(uint256)` → quorumBps, approvalBps, review, hold, exclusive. */
const lane = (quorumBps: number, approvalBps: number, review: number) =>
  `0x${[quorumBps, approvalBps, review, 0, 0].map(word).join("")}`;
answerCall(POLICY, "lanes(uint256)", 0, lane(2000, 5000, 2 * DAY));
answerCall(POLICY, "lanes(uint256)", 1, lane(1000, 5000, DAY));
// No address is left out of the votes: the auction holds nothing unclaimed here.
answer(POLICY, "excludedHolders()", `0x${word(32)}${word(0)}`);

// ── what the Shares allow: new ones only for work, and trading ───────────────
// A DAO that keeps these rules: up to 2% a year for accepted work, no lock on
// transfers, no notice to unlock them, and the team's tranche still held back.
answer(SHARES, "issuanceCapBps()", `0x${word(200)}`);
answer(SHARES, "yearStart()", `0x${word(0)}`);
answer(SHARES, "yearBase()", `0x${word(SUPPLY)}`);
answer(SHARES, "issuedThisYear()", `0x${word(0)}`);
answer(SHARES, "transfersLocked()", `0x${word(0)}`);
answer(SHARES, "unlockNoticeRequired()", `0x${word(0)}`);
answer(SHARES, "unlockAnnouncedAt()", `0x${word(0)}`);
answer(SHARES, "transferExempt()", `0x${wordAddr(ZERO)}`);
answer(LOCK, "totalLocked()", `0x${word(THE_TEAM)}`);
// A factory made before the funding-terms contract: it answers with no address.
answer(FACTORY, "fundingTerms()", `0x${wordAddr(ZERO)}`);

// ── the gate the live raise wired: the epoch's root, and the score it asks ───
// The first publisher's root, and the score its first member just reaches.
answer(GATE, "scoreRoot()", bundleA.root);
answer(GATE, "minScore()", `0x${word(50)}`);

const RPC_STUB = "http://stub.local/rpc";

const stubRoute = async (route: import("@playwright/test").Route) => {
  const request = JSON.parse(route.request().postData() ?? "{}") as {
    id?: number;
    method?: string;
    params?: unknown[];
  };
  const reply = (result: unknown) =>
    route.fulfill({
      json: { jsonrpc: "2.0", id: request.id ?? 1, result },
    });
  if (request.method === "eth_chainId") return reply("0x7a69");
  if (request.method === "net_version") return reply("31337");
  if (request.method === "eth_blockNumber")
    return reply(`0x${word(NOW % 1025)}`);
  if (request.method === "eth_getLogs") return reply([]);
  if (request.method === "eth_getCode") return reply("0x6080");
  if (request.method === "eth_getBlockByNumber")
    return reply({ timestamp: `0x${word(NOW)}`, number: `0x${word(1024)}` });
  if (request.method === "eth_call") {
    const [call] = (request.params ?? []) as [{ to: string; data: string }];
    const to = call.to.toLowerCase();
    const data = call.data.toLowerCase().replace(/^0x/, "");
    // The exact call first (an answer that depends on the argument), then the function's answer for any argument.
    const hit =
      answers[`${to}|${data}`] ?? answers[`${to}|${data.slice(0, 8)}`];
    if (hit) return reply(hit);
    return route.fulfill({
      status: 200,
      json: {
        jsonrpc: "2.0",
        id: request.id ?? 1,
        error: { code: 3, message: "nothing recorded for this call" },
      },
    });
  }
  return route.fulfill({
    status: 200,
    json: {
      jsonrpc: "2.0",
      id: request.id ?? 1,
      error: { code: -32601, message: `not recorded: ${request.method}` },
    },
  });
};

// ── the two launch records the mock relay serves ─────────────────────────────
const recordBody = (stage: string) =>
  JSON.stringify({
    pitch:
      stage === "graduated"
        ? "The front page of a live project, one action at a time."
        : "A raise still running, before the project has a DAO to run it.",
    stage,
    currency: CURRENCY,
    floorPrice: "792281625140000",
    tickSpacing: "79228162514",
    requiredRaised: "149999999998",
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "20000000",
    },
    unlocks: {
      mode: "milestones",
      allocationPct: 25,
      milestones: [
        {
          claim: "m1",
          label:
            "A public beta is live at a web address anyone can open, with its source published",
          percent: 50,
          verifier: "founder",
        },
        {
          claim: "m2",
          label: "Version 1.0 is released at the same address",
          percent: 50,
          verifier: "founder",
        },
      ],
      months: null,
    },
  });

const record = (name: string, stage: string, hook?: string) => ({
  id: `story-${stage}`,
  pubkey: "ab".repeat(32),
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", `nebula-${stage}`],
    ["name", name],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
    ["token", SHARES],
    ["currency", CURRENCY],
    // The TrustGraph card renders when the record wires a gate hook.
    ...(hook ? [["hook", hook, "1"]] : []),
  ],
  content: recordBody(stage),
  sig: "sig",
});

// ── pages ────────────────────────────────────────────────────────────────────
interface Person {
  wallet: string | null;
}

async function storyPage(
  relay: ReturnType<typeof createMockRelay>,
  context: import("@playwright/test").BrowserContext,
  person: Person | null,
): Promise<Page> {
  const page = await context.newPage();
  await relay.install(page);
  if (person?.wallet)
    await installAnvilWallet(page, person.wallet, { rpcUrl: RPC_STUB });
  await page.addInitScript(
    ([rpc]) => {
      window.localStorage.setItem("buzz.launchpad.rpc", rpc);
    },
    [RPC_STUB],
  );
  return page;
}

async function openDao(page: Page) {
  await page.goto("/launchpad");
  await page.getByText("Story DAO").click();
  await page.getByTestId("dao-overview").waitFor({ timeout: 30_000 });
}

async function shot(
  page: Page,
  name: string,
  locator?: import("@playwright/test").Locator,
) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  if (locator) {
    await locator.screenshot({ path: `${dir}/story-${name}.png` });
    return;
  }
  await page.screenshot({ path: `${dir}/story-${name}.png`, fullPage: true });
}

test("the front page shows one next action, the window it waits on, and reads failure as failure", async ({
  context,
}) => {
  test.setTimeout(180_000);
  const relay = createMockRelay();
  relay.seed(record("Story DAO", "graduated"));
  relay.seed(record("Ledger Live", "live", GATE));
  relay.seed(recordA);
  relay.seed(recordB);

  // ── The holder's front page: ONE next action, in words that stay true ──────
  const holder = await storyPage(relay, context, { wallet: HOLDER });
  await holder.route(RPC_STUB, stubRoute);
  await openDao(holder);

  const lead = holder.getByTestId("dao-next-action");
  await expect(lead).toContainText("Your one next action");
  await expect(lead).toContainText("The team published milestone 1.");
  await expect(lead).toContainText("Whose turn: yours — holder.");
  // The date names the window that closes. A clock closes a window; it never
  // runs a contract, and the page must never say it does.
  await expect(lead).toContainText("The review window ends");
  await expect(lead).toContainText("You hold Shares in this project.");
  await expect(lead).toContainText("If nobody objects, the milestone unlocks");
  expect(await holder.getByText("changes by itself").count()).toBe(0);
  // One prominent button; nothing else in the queue repeats it.
  expect(await lead.locator("button").count()).toBe(1);
  await expect(lead.locator("button")).toContainText("Read the evidence");
  await expect(holder.getByTestId("dao-attention")).toHaveCount(0);
  await shot(holder, "1-holder-front-page");

  // The lead's button lands where the work happens.
  await holder.getByTestId("dao-needs-you").scrollIntoViewIfNeeded();
  await lead.locator("button").click();
  await expect(
    holder
      .getByTestId("milestones-tab")
      .or(holder.getByTestId("challenge-milestones")),
  ).toBeVisible({ timeout: 20_000 });

  // ── The same page names the same moment for the agreement ──────────────────
  await openDao(holder);
  const raiseDetails = holder.getByTestId("dao-raise-details");
  // The raise's own disclosure, not the "Technical details" one folded inside it.
  const raiseSummary = raiseDetails.locator("summary").first();
  await expect(raiseSummary).toBeVisible();
  await raiseSummary.click();
  const agreementNext = holder.getByTestId("launch-agreement-next");
  await expect(agreementNext).toContainText("The one thing next: milestone 1");
  await expect(agreementNext).toContainText(
    "Whose turn: holders who can object.",
  );
  await expect(agreementNext).toContainText("The window to object ends");
  expect((await agreementNext.innerText()).includes("changes by itself")).toBe(
    false,
  );
  await shot(holder, "2-agreement-next", agreementNext);

  // ── The lead is reachable from the keyboard ────────────────────────────────
  let reached = false;
  for (let i = 0; i < 60; i++) {
    await holder.keyboard.press("Tab");
    const onLead = await holder.evaluate(() =>
      Boolean(
        document.activeElement?.closest('[data-testid="dao-next-action"]'),
      ),
    );
    if (onLead) {
      reached = true;
      break;
    }
  }
  expect(reached).toBe(true);

  // ── The same page on a phone: the lead stays first and open ────────────────
  await holder.setViewportSize({ width: 390, height: 844 });
  await expect(holder.getByTestId("dao-next-action")).toBeVisible();
  await shot(holder, "3-holder-phone", holder.getByTestId("dao-needs-you"));
  await holder.setViewportSize({ width: 1280, height: 720 });

  // ── A failed read is a failed read: never "nothing is waiting" ─────────────
  await holder.route(
    new RegExp(RPC_STUB.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")),
    (route) => route.fulfill({ status: 503, body: "unavailable" }),
  );
  await holder.reload();
  await expect(holder.getByTestId("dao-unread")).toContainText(
    "Could not read this project just now",
    { timeout: 60_000 },
  );
  expect(await holder.getByTestId("dao-nothing").count()).toBe(0);
  await shot(holder, "4-read-failed", holder.getByTestId("dao-unread"));
  await holder.unroute(
    new RegExp(RPC_STUB.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")),
  );
  await holder.route(RPC_STUB, stubRoute);
  await holder.getByTestId("dao-unread-retry").click();
  await expect(holder.getByTestId("dao-next-action")).toBeVisible({
    timeout: 60_000,
  });

  // ── The raise still running names the agreement, and the graph loads only on request ──
  let proofRequests = 0;
  const live = await storyPage(relay, context, null);
  await live.route(RPC_STUB, stubRoute);
  await live.route(/^https:\/\/proofs\.local\//, (route) => {
    proofRequests += 1;
    const url = route.request().url();
    const bundle = url.includes("epoch-1-a") ? bundleA : bundleB;
    route.fulfill({ json: { proofs: bundle.proofs } });
  });
  await live.goto("/launchpad");
  await live.getByText("Ledger Live").click();
  const liveNext = live.getByTestId("launch-agreement-next");
  await expect(liveNext).toContainText("The one thing next: milestone 1", {
    timeout: 30_000,
  });
  await expect(liveNext).toContainText("The window to object ends");
  await shot(live, "5-live-page");

  // Two publishers' roots for the same epoch are two choices; the dropdown names the claim it is.
  const technical = live.getByTestId("launch-technical");
  await technical.locator("summary").click();
  const epochSelect = live.getByLabel("Published score list", { exact: true });
  await expect(epochSelect.locator("option")).toHaveCount(3, {
    timeout: 30_000,
  }); // placeholder + two signed records
  // Both signed records name the claim they are: a reader choosing one is choosing a publisher's word, not "the score".
  await expect(
    epochSelect.locator("option").filter({ hasText: /publisher's own claim/ }),
  ).toHaveCount(2);

  // No remote proofs are fetched — not on opening, not on choosing.
  await epochSelect.selectOption(recordA.id);
  await live.waitForTimeout(400);
  expect(proofRequests).toBe(0);

  // The reader asks; the proofs for THAT record come back and are checked against its root.
  await live.getByTestId("trust-gate-load-proofs").click();
  await expect(technical.getByTestId("trust-graph-tree")).toBeVisible({
    timeout: 20_000,
  });
  await expect(technical).toContainText(
    "2 scored members · 2 proofs verified against the published list",
  );
  await expect(technical).toContainText(
    "the list rebuilt from these proofs matches the published one",
  );
  expect(proofRequests).toBe(1);

  // Choosing the other publisher ends the first: no cross-posted bundle shows, and nothing loads until asked.
  await epochSelect.selectOption(recordB.id);
  await live.waitForTimeout(400);
  await expect(live.getByTestId("trust-gate-load-proofs")).toBeVisible();
  expect(await technical.getByTestId("trust-graph-tree").count()).toBe(0);
  expect(proofRequests).toBe(1);

  // B's proofs come from B's pointer, checked against B's root.
  await live.getByTestId("trust-gate-load-proofs").click();
  await expect(technical.getByTestId("trust-graph-tree")).toBeVisible({
    timeout: 20_000,
  });
  await expect(technical).toContainText(
    `score list ${bundleB.root.slice(0, 10)}`, // shortHex: 0x+8 chars
  );
  expect(proofRequests).toBe(2);

  // ── Not connected: no prompts that assume a wallet, and no false quiet ─────
  const visitor = await storyPage(relay, context, null);
  await visitor.route(RPC_STUB, stubRoute);
  await openDao(visitor);
  await expect(visitor.getByTestId("dao-needs-you")).toHaveCount(0);
  await expect(visitor.getByTestId("dao-next-action")).toHaveCount(0);
  expect(await visitor.getByText("Nothing is waiting for you.").count()).toBe(
    0,
  );
  await shot(visitor, "6-visitor-front-page");

  // ── The team's own page at the same moment is honest about its quiet ───────
  const team = await storyPage(relay, context, { wallet: FOUNDER });
  await team.route(RPC_STUB, stubRoute);
  await openDao(team);
  await expect(team.getByTestId("dao-next-action")).toHaveCount(0);
  await expect(
    team
      .getByTestId("dao-nothing")
      .filter({ hasText: /nothing is waiting for you/i })
      .first(),
  ).toBeVisible();
  await shot(team, "7-team-front-page", team.getByTestId("dao-needs-you"));
});
