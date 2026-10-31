import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Submissions and reviews on a contributor project's Work tab, in the browser, against a stubbed server and a stubbed
 * chain that keeps state (same-origin `/test-rpc`): a reviewer's turn-down, with its reason, reaches the contributor;
 * an objection quorum is closed as turned down from Needs you and the Work tab; and Refresh reads the evidence again.
 *
 * Every person is their own browser context with their own key and wallet (`window.ethereum` forwarding to the stub).
 * The real-chain run of the same steps is the integrator's (`scripts/web-contributor-e2e.sh`).
 */

const hex = (bytes: Uint8Array) => bytesToHex(bytes);
const keccak = (text: string) => `0x${hex(keccak_256(utf8ToBytes(text)))}`;
const sel = (signature: string) => keccak(signature).slice(0, 10);
const word = (n: bigint | string) =>
  (typeof n === "bigint" ? n.toString(16) : n.replace(/^0x/, "")).padStart(
    64,
    "0",
  );
const words = (...values: (bigint | string)[]) =>
  `0x${values.map(word).join("")}`;
const label = (text: string) =>
  `0x${Buffer.from(text, "utf8").toString("hex").padEnd(64, "0")}`;
const a = (byte: string) => `0x${byte.repeat(20)}`;
const keyOf = (nsec: string) =>
  getPublicKey(Uint8Array.from(Buffer.from(nsec, "hex")));

const PEOPLE = {
  founder: { nsec: "6".repeat(64), wallet: a("f0"), name: "Fay" },
  contributor: { nsec: "7".repeat(64), wallet: a("c1"), name: "Cleo" },
  rui: { nsec: "8".repeat(64), wallet: a("a1"), name: "Rui" },
  rae: { nsec: "9".repeat(64), wallet: a("a2"), name: "Rae" },
} as const;
type Who = keyof typeof PEOPLE;
const FOUNDER = keyOf(PEOPLE.founder.nsec);

const DAO = a("da");
const POLICY = a("70");
const FACTORY = a("fa");
const SHARES = a("5e");
const MANDATE = a("b1");
const CLAIMS = a("c5");
const VERIFIERS = a("ee");
const AREA = label("docs");
const CLAIM = label("translate");
const CHECK = "The page reads well in German";
const EVIDENCE = "https://example.com/pr/7";
const NOW = 1_900_000_000;
const FAR = 2_000_000_000n;
const LAUNCH_ID = "docs-commons";
const COORD = `37001:${FOUNDER}:${LAUNCH_ID}`;

const TOPIC = {
  mandateCreated: keccak(
    "MandateCreated(address,address,address,uint128,uint128,uint128,uint128)",
  ),
  projectApproved: keccak(
    "ProjectApproved(bytes32,address,uint128,uint128,uint64,bytes32)",
  ),
  claimSubmitted: keccak(
    "ClaimSubmitted(bytes32,address,uint256,uint256,bytes32)",
  ),
  verifierAccepted: keccak("VerifierAccepted(address,uint256)"),
  attested: keccak("Attested(bytes32,address,bool)"),
};
const SEL = {
  votingWeight: sel("votingWeight()"),
  mandateFactory: sel("mandateFactory()"),
  claims: sel("claims()"),
  verifiers: sel("verifiers()"),
  closed: sel("closed()"),
  expiresAt: sel("expiresAt()"),
  sharesAllocated: sel("sharesAllocated()"),
  quorum: sel("quorum()"),
  challengeWindow: sel("challengeWindow()"),
  project: sel("projects(bytes32)"),
  claim: sel("claims(bytes32)"),
  claimProject: sel("claimProject(bytes32)"),
  awarded: sel("contributionAwarded(bytes32)"),
  approvalCount: sel("approvalCount(bytes32)"),
  objectionCount: sel("objectionCount(bytes32)"),
  attestedBy: sel("attested(bytes32,address)"),
  reviewer: sel("verifiers(address)"),
  attest: sel("attest(bytes32,bool)"),
  settle: sel("settle(bytes32)"),
  shares: sel("shares()"),
  totalSupply: sel("totalSupply()"),
  balanceOf: sel("balanceOf(address)"),
  lockGuard: sel("lockGuard()"),
};
const STATUS = { Open: 0n, Rejected: 2n };

/** What the stub chain holds: one claim in one work area, judged by Rui and Rae, both needed. */
interface World {
  status: bigint;
  /** Reviewer wallet (lower case) to their answer. */
  answers: Map<string, boolean>;
  sent: { from: string; data: string }[];
}

const record = {
  id: "a".repeat(64),
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", LAUNCH_ID],
    ["name", "Docs Commons"],
    ["t", "dao-launchpad"],
    ["admission", "community"],
    ["chain", "31337"],
    ["token", SHARES],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "Open docs for everyone, written by the people who use them.",
    stage: "graduated",
    funding: {
      stance: "not-raising",
      seeking: ["contributors"],
      path: "contributors",
    },
    tokenPlan: {
      mode: "dao",
      name: "Docs Commons",
      symbol: "DOCS",
      supply: "100000",
    },
  }),
  sig: "sig",
};

let seq = 0;
const event = (
  pubkey: string,
  kind: number,
  tags: string[][],
  content: unknown,
) => ({
  id: (++seq).toString(16).padStart(64, "0"),
  pubkey,
  created_at: 200 + seq,
  kind,
  tags,
  content: typeof content === "string" ? content : JSON.stringify(content),
  sig: "sig",
});

/** The contributor's evidence for the claim, as the submit form publishes it. */
const evidenceEvent = () =>
  event(keyOf(PEOPLE.contributor.nsec), 47003, [["a", COORD]], {
    title: "Evidence: translate",
    body: EVIDENCE,
    links: [EVIDENCE],
    claim: { id: CLAIM, mandate: MANDATE, check: CHECK },
  });

/** A person's link from their account to their wallet (their payment wallet record). */
const bindingEvent = (who: Who) => {
  const person = PEOPLE[who];
  return event(
    keyOf(person.nsec),
    37017,
    [
      ["d", person.wallet],
      ["address", person.wallet],
    ],
    {
      v: 1,
      address: person.wallet,
      siweMessageHash: "0x",
      attestation: "x",
    },
  );
};

/** Everyone's name, and everyone's wallet linked to it except `unlinked`'s. */
function seedPeople(
  relay: ReturnType<typeof createMockRelay>,
  unlinked: Who | null = null,
) {
  relay.seed(record);
  for (const [who, person] of Object.entries(PEOPLE) as [
    Who,
    (typeof PEOPLE)[Who],
  ][]) {
    const pubkey = keyOf(person.nsec);
    relay.seed(event(pubkey, 0, [], { name: person.name }));
    if (who === unlinked) continue;
    relay.seed(
      event(
        pubkey,
        37017,
        [
          ["d", person.wallet],
          ["address", person.wallet],
        ],
        {
          v: 1,
          address: person.wallet,
          siweMessageHash: "0x",
          attestation: "x",
        },
      ),
    );
  }
}

const log = (address: string, topics: string[], data: string) => ({
  address,
  topics,
  data,
  blockNumber: "0x5",
  transactionHash: `0x${"cd".repeat(32)}`,
  logIndex: "0x0",
});

/** Answer the reads the Work, Overview and Contributions tabs make, and the sends a reviewer and the founder make. */
async function installChain(context: BrowserContext, world: World) {
  await context.route("**/test-rpc", async (route) => {
    const { id, method, params } = JSON.parse(
      route.request().postData() ?? "{}",
    ) as { id: number; method: string; params: Record<string, unknown>[] };
    const reply = (body: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
      });
    const reverted = () =>
      reply({ error: { code: 3, message: "execution reverted" } });
    if (method === "eth_chainId") return reply({ result: "0x7a69" });
    if (method === "eth_blockNumber") return reply({ result: "0x20" });
    if (method === "eth_getBlockByNumber") {
      return reply({
        result: { number: "0x20", timestamp: `0x${NOW.toString(16)}` },
      });
    }
    if (method === "eth_getTransactionReceipt") {
      return reply({
        result: {
          status: "0x1",
          blockNumber: "0x20",
          gasUsed: "0x0",
          logs: [],
        },
      });
    }
    if (method === "eth_sendTransaction") {
      const tx = params[0] as { from: string; to: string; data: string };
      const from = tx.from.toLowerCase();
      world.sent.push({ from, data: tx.data });
      if (tx.data.startsWith(SEL.attest)) {
        if (world.answers.has(from)) return reverted();
        world.answers.set(from, tx.data.endsWith("1"));
      } else if (tx.data.startsWith(SEL.settle)) {
        const no = [...world.answers.values()].filter((v) => !v).length;
        if (world.status !== STATUS.Open || no < 2) return reverted();
        world.status = STATUS.Rejected;
      } else {
        return reverted();
      }
      return reply({ result: `0x${word(BigInt(world.sent.length))}` });
    }
    const target = String(
      params?.[0]?.address ?? params?.[0]?.to ?? "",
    ).toLowerCase();
    if (method === "eth_getLogs") {
      const topics = (params[0]?.topics ?? []) as (string | null)[];
      const t0 = topics[0];
      if (target === FACTORY && t0 === TOPIC.mandateCreated) {
        return reply({
          result: [
            log(
              FACTORY,
              [t0, `0x${word(DAO)}`, `0x${word(MANDATE)}`],
              words(a("c0"), 0n, 0n, 100_000n, 25_000n),
            ),
          ],
        });
      }
      if (target === MANDATE && t0 === TOPIC.projectApproved) {
        return reply({
          result: [
            log(
              MANDATE,
              [t0, AREA, `0x${word(PEOPLE.founder.wallet)}`],
              words(0n, 25_000n, FAR, keccak(CHECK)),
            ),
          ],
        });
      }
      if (target === CLAIMS && t0 === TOPIC.claimSubmitted) {
        return reply({
          result: [
            log(
              CLAIMS,
              [t0, CLAIM],
              words(PEOPLE.contributor.wallet, 0n, 0n, keccak(EVIDENCE)),
            ),
          ],
        });
      }
      if (target === VERIFIERS && t0 === TOPIC.verifierAccepted) {
        return reply({
          result: [PEOPLE.rui.wallet, PEOPLE.rae.wallet].map((r) =>
            log(VERIFIERS, [t0, `0x${word(r)}`], words(0n)),
          ),
        });
      }
      if (target === VERIFIERS && t0 === TOPIC.attested) {
        return reply({
          result: [...world.answers].map(([r, yes]) =>
            log(VERIFIERS, [t0, CLAIM, `0x${word(r)}`], words(yes ? 1n : 0n)),
          ),
        });
      }
      return reply({ result: [] });
    }
    if (method !== "eth_call") {
      return reply({ error: { code: -32601, message: `no ${method}` } });
    }
    const data = String(params[0]?.data ?? "").toLowerCase();
    const arg = (n: number) =>
      `0x${data.slice(10 + n * 64, 10 + (n + 1) * 64)}`;
    const answer = (result: string) => reply({ result });
    const at = (to: string, selector: string) =>
      target === to && data.startsWith(selector);
    if (at(DAO, SEL.votingWeight)) return answer(words(POLICY));
    if (at(POLICY, SEL.mandateFactory)) return answer(words(FACTORY));
    if (at(MANDATE, SEL.claims) && data.length === 10)
      return answer(words(CLAIMS));
    if (at(MANDATE, SEL.verifiers) && data.length === 10)
      return answer(words(VERIFIERS));
    if (at(MANDATE, SEL.closed)) return answer(words(0n));
    if (at(MANDATE, SEL.expiresAt)) return answer(words(FAR));
    if (at(MANDATE, SEL.sharesAllocated)) return answer(words(0n));
    if (at(VERIFIERS, SEL.quorum)) return answer(words(2n));
    if (at(CLAIMS, SEL.challengeWindow)) return answer(words(604_800n));
    if (at(MANDATE, SEL.project) && arg(0) === AREA) {
      return answer(
        words(PEOPLE.founder.wallet, 0n, 0n, FAR, keccak(CHECK), 25_000n, 0n),
      );
    }
    if (at(CLAIMS, SEL.claim) && arg(0) === CLAIM) {
      return answer(
        words(
          PEOPLE.contributor.wallet,
          0n,
          0n,
          world.status,
          keccak(EVIDENCE),
          keccak(CHECK),
          FAR,
          0n,
        ),
      );
    }
    if (at(MANDATE, SEL.claimProject) && arg(0) === CLAIM) return answer(AREA);
    if (at(MANDATE, SEL.awarded)) return answer(words(0n));
    const count = (yes: boolean) =>
      BigInt([...world.answers.values()].filter((v) => v === yes).length);
    if (at(VERIFIERS, SEL.approvalCount)) return answer(words(count(true)));
    if (at(VERIFIERS, SEL.objectionCount)) return answer(words(count(false)));
    if (at(VERIFIERS, SEL.attestedBy)) {
      const who = `0x${arg(1).slice(-40)}`;
      return answer(words(world.answers.has(who) ? 1n : 0n));
    }
    if (at(VERIFIERS, SEL.reviewer)) {
      const who = `0x${arg(0).slice(-40)}`;
      const on = who === PEOPLE.rui.wallet || who === PEOPLE.rae.wallet;
      return answer(words(on ? 1n : 0n, 0n, 0n, 0n));
    }
    // What the Contributions tab reads: the DAO's Shares, all the founder's.
    if (at(DAO, SEL.shares)) return answer(words(SHARES));
    if (at(SHARES, SEL.totalSupply))
      return answer(words(100_000n * 10n ** 18n));
    if (at(SHARES, SEL.balanceOf)) return answer(words(0n));
    // No team Shares held back behind milestones: the track record reads none.
    if (at(SHARES, SEL.lockGuard)) return answer(words(0n));
    return reverted();
  });
}

/** One person: their own key, their own wallet, the shared server and chain. */
async function openAs(
  browser: Browser,
  who: Who,
  relay: ReturnType<typeof createMockRelay>,
  world: World,
): Promise<Page> {
  const context = await browser.newContext();
  await installChain(context, world);
  const person = PEOPLE[who];
  await context.addInitScript(
    ({ nsec, wallet }) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem(
        "buzz.launchpad.rpc",
        `${window.location.origin}/test-rpc`,
      );
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: async ({
            method,
            params,
          }: {
            method: string;
            params?: unknown[];
          }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts")
              return [wallet];
            const res = await fetch("/test-rpc", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params: params ?? [],
              }),
            });
            const body = await res.json();
            if (body.error) {
              throw { code: body.error.code, message: body.error.message };
            }
            return body.result;
          },
          on() {},
          removeListener() {},
        },
      });
    },
    { nsec: person.nsec, wallet: person.wallet },
  );
  const page = await context.newPage();
  await relay.install(page);
  return page;
}

const projectPath = (tab: string) =>
  `/launchpad/${LAUNCH_ID}?author=${FOUNDER}&tab=${tab}`;
const claimCard = (page: Page) =>
  page.getByTestId("work-claim").filter({ hasText: "translate" });

async function turnDown(page: Page, reason: string) {
  await page.goto(projectPath("work"));
  const card = claimCard(page);
  await expect(card.getByTestId("work-evidence-text")).toHaveText(EVIDENCE, {
    timeout: 20_000,
  });
  await card.getByTestId("work-object").click();
  // A turn-down cannot be taken back: it asks first, with room for the reason, and the reason field has the focus.
  const form = card.getByTestId("work-object-form");
  await expect(form).toBeVisible();
  await expect(card.getByTestId("work-object-reason")).toBeFocused();
  await page.keyboard.type(reason);
  await card.getByTestId("work-object-confirm").click();
  await expect(form).toHaveCount(0, { timeout: 20_000 });
  // Their answer is in: the buttons are gone for them, and the focus is on the claim, not lost to the page.
  await expect(card.getByTestId("work-object")).toHaveCount(0);
  await expect(card).toBeFocused();
}

test("two reviewers turn work down with a reason: the founder closes it from Needs you, and the contributor reads why", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay();
  seedPeople(relay);
  relay.seed(evidenceEvent());
  const world: World = { status: STATUS.Open, answers: new Map(), sent: [] };

  const rui = await openAs(browser, "rui", relay, world);
  await turnDown(rui, "The German page is missing. Add it and submit again.");
  // The reason was published before the turn-down was sent, naming the claim and Rui's wallet.
  const reasons = relay.events.filter(
    (e) => e.kind === 47003 && e.content.includes('"review"'),
  );
  expect(reasons).toHaveLength(1);
  expect(JSON.parse(reasons[0].content).review).toEqual({
    id: CLAIM,
    mandate: MANDATE,
    reviewer: PEOPLE.rui.wallet,
    verdict: "object",
  });
  expect(world.answers.get(PEOPLE.rui.wallet)).toBe(false);
  // One of two: it waits, and the line says someone turned it down.
  await expect(claimCard(rui).getByTestId("work-claim-next")).toContainText(
    "0 of 2 approvals, 1 turned it down",
  );
  await expect(claimCard(rui).getByTestId("work-claim-reason")).toContainText(
    "The German page is missing",
  );
  await expectAccessible(rui, "work tab after a turn-down");

  const rae = await openAs(browser, "rae", relay, world);
  // Pressing it and thinking better of it sends nothing.
  await rae.goto(projectPath("work"));
  const raeCard = claimCard(rae);
  await raeCard.getByTestId("work-object").click({ timeout: 20_000 });
  await raeCard.getByTestId("work-object-reason").press("Escape");
  await expect(raeCard.getByTestId("work-object-form")).toHaveCount(0);
  // Escape cancels from anywhere in the form, not only the reason box.
  await raeCard.getByTestId("work-object").click();
  await raeCard.getByTestId("work-object-confirm").press("Escape");
  await expect(raeCard.getByTestId("work-object-form")).toHaveCount(0);
  await expect(raeCard.getByTestId("work-object")).toBeFocused();
  expect(world.answers.has(PEOPLE.rae.wallet)).toBe(false);
  await turnDown(rae, "Agreed: half the headings are still in English.");
  await expect(claimCard(rae).getByTestId("work-claim-next")).toContainText(
    "Enough reviewers turned it down",
  );

  // The contributor, before anyone closes it: told it was turned down, with the reasons on the claim.
  const contributor = await openAs(browser, "contributor", relay, world);
  await contributor.goto(projectPath("overview"));
  await expect(contributor.getByTestId("dao-waiting-others")).toContainText(
    "The reviewers turned down your “Translate”. The Work tab shows who, and their reasons if they gave any.",
    { timeout: 20_000 },
  );

  // The founder manages the work area: Needs you offers the close, and it opens the claim on the Work tab.
  const founder = await openAs(browser, "founder", relay, world);
  await founder.goto(projectPath("overview"));
  const item = founder
    .getByTestId("dao-attention")
    .filter({ hasText: "Enough reviewers turned down “translate”" });
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.getByRole("button", { name: "Close it as turned down" }).click();
  const settle = claimCard(founder).getByTestId("work-settle");
  await expect(settle).toHaveText("Close it as turned down", {
    timeout: 20_000,
  });
  await settle.click();
  await expect(
    claimCard(founder).getByTestId("work-claim-status"),
  ).toContainText("Rejected", { timeout: 20_000 });
  expect(world.status).toBe(STATUS.Rejected);

  // The contributor reads the verdict, who gave it, and why, on the claim and on Contributions.
  await contributor.goto(projectPath("work"));
  const mine = claimCard(contributor);
  await expect(mine.getByTestId("work-claim-status")).toContainText(
    "Rejected",
    { timeout: 20_000 },
  );
  await expect(mine.getByTestId("work-claim-next")).toContainText(
    "Turned down by the reviewers. To try again, fix the work and submit it under a new name.",
  );
  await expect(mine.getByTestId("work-claim-reviewers")).toContainText(
    "Turned down by Rui",
  );
  await expect(mine.getByTestId("work-claim-reason")).toHaveCount(2);
  await expect(mine.getByTestId("work-claim-reason").first()).toContainText(
    "Why Rui",
  );
  await expect(mine.getByTestId("work-claim-reason").first()).toContainText(
    "The German page is missing. Add it and submit again.",
  );
  await contributor.goto(projectPath("contributions"));
  const turned = contributor.getByTestId("contribution-turned-down");
  await expect(turned).toContainText("Translate", { timeout: 20_000 });
  await expect(turned).toContainText("half the headings are still in English");
});

test("a reason published under a reviewer's wallet by someone else is never shown", async ({
  browser,
}) => {
  const relay = createMockRelay();
  seedPeople(relay);
  relay.seed(evidenceEvent());
  // Cleo names Rui's wallet; Rui really did turn it down, but did not write this.
  relay.seed(
    event(keyOf(PEOPLE.contributor.nsec), 47003, [["a", COORD]], {
      title: "Turned down: translate",
      body: "forged reason",
      links: [],
      review: {
        id: CLAIM,
        mandate: MANDATE,
        reviewer: PEOPLE.rui.wallet,
        verdict: "object",
      },
    }),
  );
  const world: World = {
    status: STATUS.Open,
    answers: new Map([[PEOPLE.rui.wallet, false]]),
    sent: [],
  };
  const page = await openAs(browser, "founder", relay, world);
  await page.goto(projectPath("work"));
  await expect(
    claimCard(page).getByTestId("work-claim-reviewers"),
  ).toContainText("Turned down by Rui", { timeout: 20_000 });
  await expect(claimCard(page).getByTestId("work-claim-reason")).toHaveCount(0);
});

test("a reviewer whose account is not linked to their name is told, and no reason nobody would see is published (D145)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay();
  seedPeople(relay, "rui");
  relay.seed(evidenceEvent());
  const world: World = { status: STATUS.Open, answers: new Map(), sent: [] };
  const reasons = () =>
    relay.events.filter(
      (e) => e.kind === 47003 && e.content.includes('"review"'),
    );

  const rui = await openAs(browser, "rui", relay, world);
  await rui.goto(projectPath("work"));
  const card = claimCard(rui);
  await expect(card.getByTestId("work-evidence-text")).toHaveText(EVIDENCE, {
    timeout: 20_000,
  });
  await card.getByTestId("work-object").click();
  // Said in the form, before anything is written: a reason from this account would not reach the contributor.
  const unlinked = card.getByTestId("work-object-unlinked");
  await expect(unlinked).toContainText(
    "The contributor can't see a reason from this account yet: it isn't linked to your name.",
    { timeout: 20_000 },
  );
  await expect(unlinked).toContainText("Payment wallet on your profile");
  await card
    .getByTestId("work-object-reason")
    .fill("The German page is missing.");
  await card.getByTestId("work-object-confirm").click();
  await expect(card.getByTestId("work-object-problem")).toContainText(
    "This account isn't linked to your name, so the contributor would not see your reason. Nothing was sent.",
  );
  expect(reasons()).toHaveLength(0);
  expect(world.answers.has(PEOPLE.rui.wallet)).toBe(false);
  await expectAccessible(rui, "turn-down form for an account not linked");

  // Rui links his wallet (on his profile, elsewhere). Pressing again reads the link again: the reason is published,
  // then the turn-down sent.
  relay.seed(bindingEvent("rui"));
  await card.getByTestId("work-object-confirm").click();
  await expect(card.getByTestId("work-object-form")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(reasons()).toHaveLength(1);
  expect(JSON.parse(reasons()[0].content).review.reviewer).toBe(
    PEOPLE.rui.wallet,
  );
  expect(world.answers.get(PEOPLE.rui.wallet)).toBe(false);
});

test("an unlinked reviewer can still turn work down without a reason (D145)", async ({
  browser,
}) => {
  const relay = createMockRelay();
  seedPeople(relay, "rui");
  relay.seed(evidenceEvent());
  const world: World = { status: STATUS.Open, answers: new Map(), sent: [] };
  const rui = await openAs(browser, "rui", relay, world);
  await rui.goto(projectPath("work"));
  const card = claimCard(rui);
  await card.getByTestId("work-object").click({ timeout: 20_000 });
  await expect(card.getByTestId("work-object-unlinked")).toBeVisible({
    timeout: 20_000,
  });
  await card.getByTestId("work-object-confirm").click();
  await expect(card.getByTestId("work-object-form")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(world.answers.get(PEOPLE.rui.wallet)).toBe(false);
  expect(
    relay.events.filter(
      (e) => e.kind === 47003 && e.content.includes('"review"'),
    ),
  ).toHaveLength(0);
});

test("Refresh reads the evidence again, so a reviewer is not left with only a turn-down to offer", async ({
  browser,
}) => {
  const relay = createMockRelay();
  seedPeople(relay);
  const world: World = { status: STATUS.Open, answers: new Map(), sent: [] };
  const rui = await openAs(browser, "rui", relay, world);
  await rui.goto(projectPath("work"));
  const card = claimCard(rui);
  await expect(card.getByTestId("work-evidence-missing")).toBeVisible({
    timeout: 20_000,
  });
  await expect(card.getByTestId("work-approve")).toHaveCount(0);
  // The contributor publishes it after the reviewer opened the page; nothing tells the open page.
  relay.seed(evidenceEvent());
  await rui.getByTestId("work-refresh").click();
  await expect(card.getByTestId("work-evidence-text")).toHaveText(EVIDENCE, {
    timeout: 20_000,
  });
  await expect(card.getByTestId("work-approve")).toBeVisible();
});

test("Look again on a missing piece of evidence reads it again", async ({
  browser,
}) => {
  const relay = createMockRelay();
  seedPeople(relay);
  const world: World = { status: STATUS.Open, answers: new Map(), sent: [] };
  const rae = await openAs(browser, "rae", relay, world);
  await rae.goto(projectPath("work"));
  const card = claimCard(rae);
  await expect(card.getByTestId("work-evidence-missing")).toBeVisible({
    timeout: 20_000,
  });
  relay.seed(evidenceEvent());
  await card.getByTestId("work-evidence-retry").click();
  await expect(card.getByTestId("work-evidence-text")).toHaveText(EVIDENCE, {
    timeout: 20_000,
  });
});
