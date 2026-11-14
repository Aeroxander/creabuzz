import { expect, type Page, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import {
  boughtEvent,
  FIXTURE,
  installBackingChain,
  POOL_DEFAULTS,
  type PoolFixture,
  postedEvent,
  resolvedEvent,
} from "../helpers/fake-backing-chain";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/project-world";

/**
 * Investing in the browser, against a stand-in chain node and a stubbed server: the Backing block in every state of
 * backing, the steps it sends (read off the wallet's own send calls), and the one switch.
 *
 * It needs a build made by `scripts/web-investing-mock-e2e.sh`: `E2E_INVESTING_BUILD` is "on" for the build with the
 * switch and all three addresses (made the way the hosted image makes it, contributor-only), and "off" for the build that
 * names the same addresses but leaves the switch unset, which must show nothing at all. In the default build these skip.
 */

const BUILD = process.env.E2E_INVESTING_BUILD;
const FOUNDER_KEY = "c1".repeat(32);
const VISITOR_KEY = "c2".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const COORD = coordOf(FOUNDER, "docs-commons");
const PROJECT = `/launchpad/docs-commons?author=${FOUNDER}`;
const SCORECARD = `/p/docs-commons-${FOUNDER.slice(0, 16)}`;
const ONE = 10n ** 6n;
const UNIT = 10n ** 18n;

function seed(relay: Relay) {
  relay.seed(
    event(
      0,
      FOUNDER,
      { name: "Fran Founder", display_name: "Fran Founder" },
      [],
      now() - 90 * DAY,
    ),
  );
  relay.seed(
    projectRecord(FOUNDER, "docs-commons", "Docs Commons", now() - 60 * DAY, {
      content: {
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
      },
      tags: [
        ["chain", String(FIXTURE.chainId)],
        ["treasury", FIXTURE.dao],
        ["token", `0x${"5e".repeat(20)}`],
      ],
    }),
  );
}

/** A founder's update, as the project's page reads it. */
function update(title: string, at: number) {
  return event(47003, FOUNDER, { title, body: "" }, [["a", COORD]], at);
}

async function open(
  page: Page,
  options: {
    pool: PoolFixture | null;
    as?: "founder" | "visitor" | "signed-out";
    wallet?: string | null;
    kitMadeDao?: string | null;
    updates?: ReturnType<typeof update>[];
    path?: string;
    noFounder?: boolean;
    down?: boolean;
  },
) {
  const relay = createMockRelay();
  seed(relay);
  for (const u of options.updates ?? []) relay.seed(u);
  const key =
    options.as === "signed-out"
      ? null
      : options.as === "founder"
        ? FOUNDER_KEY
        : VISITOR_KEY;
  await install(page, relay, key);
  const chain = await installBackingChain(page, {
    pool: options.pool,
    kitMadeDao: options.kitMadeDao,
    wallet:
      options.wallet === undefined ? FIXTURE.backerWallet : options.wallet,
    noFounder: options.noFounder,
    down: options.down,
  });
  await page.goto(options.path ?? PROJECT);
  return { relay, chain };
}

const block = (page: Page) => page.getByTestId("backing");

test.describe("the switch is on", () => {
  test.skip(
    BUILD !== "on",
    "needs the investing build: run scripts/web-investing-mock-e2e.sh",
  );

  test("a project with no backing says so, and offers a visitor nothing to press", async ({
    page,
  }) => {
    await open(page, { pool: null, as: "visitor" });
    await expect(block(page).getByTestId("backing-state")).toHaveText(
      "Backing is not open for this project.",
      { timeout: 30_000 },
    );
    await expect(block(page).getByRole("button")).toHaveCount(0);
    await expect(block(page).getByTestId("backing-chip")).toHaveCount(0);
  });

  test("a founder is offered to open backing now or with a fair round, and the step goes to the factory", async ({
    page,
  }) => {
    const { chain } = await open(page, {
      pool: null,
      as: "founder",
      wallet: FIXTURE.founderWallet,
    });
    await expect(block(page).getByTestId("backing-state")).toContainText(
      "You can open it",
      {
        timeout: 30_000,
      },
    );
    await expect(block(page).getByTestId("backing-open-now")).toBeVisible();
    await block(page).getByTestId("backing-open-round").click();
    await expect(block(page).getByTestId("backing-minimum")).toHaveAttribute(
      "placeholder",
      "2,500 tTEST",
    );
    await block(page).getByTestId("backing-open-now").click();
    await expect(block(page).getByTestId("backing-open-form")).toContainText(
      "Backing opens at once",
    );
    await block(page).getByTestId("backing-confirm-open").click();
    await expect.poll(() => chain.sent.length, { timeout: 15_000 }).toBe(1);
    expect(chain.sent[0].to).toBe(FIXTURE.factory);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0xb95460f8"); // open(address)
    expect(chain.sent[0].data.toLowerCase()).toContain(FIXTURE.dao.slice(2));
  });

  test("a founder on another account is told to switch, and is offered nothing to send", async ({
    page,
  }) => {
    await open(page, {
      pool: null,
      as: "founder",
      wallet: FIXTURE.backerWallet,
    });
    await expect(
      block(page).getByTestId("backing-founder-account"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(block(page).getByTestId("backing-open-now")).toHaveCount(0);
  });

  test("a live project shows what is held, what was released and the one honest line, and no price", async ({
    page,
  }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      events: [
        boughtEvent(FIXTURE.backerWallet, 100n * ONE, 1n, 10),
        boughtEvent(FIXTURE.founderWallet, 50n * ONE, 2n, 11),
      ],
    };
    await open(page, { pool, as: "signed-out", wallet: null });
    const b = block(page);
    await expect(b.getByTestId("backing-chip")).toHaveText("Open", {
      timeout: 30_000,
    });
    await expect(b.getByTestId("backing-held")).toHaveText("220 tTEST");
    await expect(b.getByTestId("backing-released")).toHaveText("40 tTEST");
    await expect(b.getByTestId("backing-paid-in")).toHaveText("150 tTEST");
    await expect(b.getByTestId("backing-honest")).toHaveText(
      "You can sell any time. At each milestone you can stay or leave with your held money back.",
    );
    // The legal lines are on the page, whole, beside the action: never collapsed.
    await expect(b.getByTestId("backing-limits")).toContainText(
      "You may get back less than you paid.",
    );
    await expect(b.getByTestId("backing-limits")).toContainText(
      "Do not put in money you cannot lose.",
    );
    await expect(b.getByTestId("backing-limits")).toBeVisible();
    // No price and no returns on a project's page: those live in Home's feed.
    await expect(b).not.toContainText(/price|returns?\b|profit|gain/i);
    // Signed out: the one thing to press is to sign in.
    await expect(b.getByTestId("backing-sign-in")).toBeVisible();
    await expect(b.getByTestId("backing-back")).toHaveCount(0);
  });

  test("a project page shows the record first and backing after it", async ({
    page,
  }) => {
    await open(page, { pool: { ...POOL_DEFAULTS }, as: "visitor" });
    await expect(block(page)).toBeVisible({ timeout: 30_000 });
    const order = await page.evaluate(() => {
      const all = [...document.querySelectorAll("section, [data-testid]")];
      const index = (id: string) =>
        all.findIndex((el) => el.getAttribute("data-testid") === id);
      return { backing: index("backing"), goal: index("project-goal") };
    });
    expect(order.backing).toBeGreaterThan(order.goal);
  });

  test("a backer puts money in: one approval and one buy, with a limit, sent together", async ({
    page,
  }) => {
    const { chain } = await open(page, {
      pool: { ...POOL_DEFAULTS },
      as: "visitor",
      wallet: FIXTURE.backerWallet,
    });
    const b = block(page);
    await b.getByTestId("backing-back").click({ timeout: 30_000 });
    await b.getByTestId("backing-amount").fill("10");
    await expect(b.getByTestId("backing-plan")).toContainText("You get about", {
      timeout: 15_000,
    });
    await expect(b.getByTestId("backing-plan")).toContainText("at least");
    await expect(b.getByTestId("backing-plan")).toContainText(
      "is held for the project until a milestone",
    );
    await b.getByTestId("backing-confirm-back").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(2);
    expect(chain.sent[0].to).toBe(FIXTURE.token);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0x095ea7b3"); // approve(address,uint256)
    expect(BigInt(`0x${chain.sent[0].data.slice(-64)}`)).toBe(10n * ONE);
    expect(chain.sent[1].to).toBe(FIXTURE.pool);
    expect(chain.sent[1].data.slice(0, 10)).toBe("0x40993b26"); // buy(uint256,uint256,uint256)
    const words =
      chain.sent[1].data
        .slice(10)
        .match(/.{64}/g)
        ?.map((w) => BigInt(`0x${w}`)) ?? [];
    expect(words[0]).toBe(10n * ONE);
    // The limit is a hundredth under the quote, and the deadline is in the future.
    const quoted = 10n * ONE * 30n;
    expect(words[1]).toBe((quoted * 99n) / 100n);
    expect(Number(words[2])).toBeGreaterThan(now());
    await expect(b.getByTestId("backing-done")).toHaveText(
      "Done. Your backing is in.",
    );
  });

  test("a problem with an amount is said in words, and nothing is sent", async ({
    page,
  }) => {
    const { chain } = await open(page, {
      pool: { ...POOL_DEFAULTS },
      as: "visitor",
    });
    const b = block(page);
    await b.getByTestId("backing-back").click({ timeout: 30_000 });
    await b.getByTestId("backing-amount").fill("1e3");
    await expect(b.getByTestId("backing-problem")).toHaveText(
      "Use a number with at most 6 decimals.",
    );
    await b.getByTestId("backing-amount").fill("999999");
    await b.getByTestId("backing-confirm-back").click();
    await expect(b.getByTestId("backing-problem")).toContainText(
      "You hold 5,000 tTEST, which is less than that.",
    );
    expect(chain.sent).toHaveLength(0);
  });

  test("a backer sells all the units, and a held position is said in words", async ({
    page,
  }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      holderUnits: 4_000_000n * UNIT,
      holderSellValue: 90n * ONE,
      holderEscrow: 10n * ONE,
    };
    const { chain } = await open(page, { pool, as: "visitor" });
    const b = block(page);
    await expect(b.getByTestId("backing-position")).toHaveText(
      "You hold 4,000,000 units. Selling them now pays 90 tTEST. 10 tTEST of what you paid is held for the project.",
      { timeout: 30_000 },
    );
    await b.getByTestId("backing-sell").click();
    await b.getByTestId("backing-sell-all").click();
    await expect(b.getByTestId("backing-units")).toHaveValue("4000000");
    await expect(b.getByTestId("backing-sell-plan")).toContainText(
      "You get about 90 tTEST",
      { timeout: 15_000 },
    );
    await b.getByTestId("backing-confirm-sell").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(1);
    expect(chain.sent[0].to).toBe(FIXTURE.pool);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0xd3c9727c"); // sell(uint256,uint256,uint256)
  });

  test("while a milestone's window runs a backer may leave, and sees the date and what leaving pays", async ({
    page,
  }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      windowEndsIn: 5 * DAY,
      holderUnits: 4_000_000n * UNIT,
      holderSellValue: 90n * ONE,
      holderEscrow: 10n * ONE,
      holderCanLeave: true,
      holderLeaveValue: 99n * ONE,
      events: [postedEvent(1n, "e".padEnd(64, "1"), FIXTURE.founderWallet, 20)],
    };
    const { chain } = await open(page, { pool, as: "visitor" });
    const b = block(page);
    await expect(b.getByTestId("backing-next")).toBeVisible({
      timeout: 30_000,
    });
    await expect(b.getByTestId("backing-milestone-note")).toContainText(
      "you can stay",
    );
    await expect(b.getByTestId("backing-milestone-note")).toContainText(
      "leave and take all of your held money back",
    );
    await b.getByTestId("backing-leave").click();
    await expect(b.getByTestId("backing-leave-plan")).toContainText(
      "You get about 99 tTEST",
      { timeout: 15_000 },
    );
    await expect(b.getByTestId("backing-leave-plan")).toContainText(
      "Nothing is taken for this milestone.",
    );
    await b.getByTestId("backing-confirm-leave").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(1);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0xe02ae075"); // leave(uint256,uint256)
    // The milestone is in the list, pointing at a record this project does not have: said so.
    await expect(b.getByTestId("backing-milestone").first()).toContainText(
      "cannot find among the project's own",
      {
        timeout: 20_000,
      },
    );
  });

  test("a milestone nobody settled in time can be closed by anyone, and one past its window can be released", async ({
    page,
  }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      windowEndsIn: -2 * DAY,
      events: [postedEvent(1n, "e".padEnd(64, "1"), FIXTURE.founderWallet, 20)],
    };
    const { chain } = await open(page, { pool, as: "visitor" });
    const b = block(page);
    await expect(b.getByTestId("backing-settle")).toHaveText(
      "Settle the milestone",
      { timeout: 30_000 },
    );
    await b.getByTestId("backing-settle").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(1);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0xe5863346"); // resolveMilestone()
  });

  test("a founder posts a milestone by picking one of the project's own records", async ({
    page,
  }) => {
    const updates = [
      update("Sign-up is live", now() - 3 * DAY),
      update("Docs are drafted", now() - 10 * DAY),
    ];
    const pool: PoolFixture = { ...POOL_DEFAULTS, nextClaimIn: -DAY };
    const { chain } = await open(page, {
      pool,
      as: "founder",
      wallet: FIXTURE.founderWallet,
      updates,
    });
    const b = block(page);
    await b.getByTestId("backing-post").click({ timeout: 30_000 });
    await expect(b.getByTestId("backing-record")).toContainText(
      "Update: Sign-up is live",
      { timeout: 20_000 },
    );
    await b.getByTestId("backing-confirm-post").click();
    await expect(b.getByTestId("backing-problem")).toHaveText(
      "Pick the record that shows this milestone.",
    );
    await b
      .getByTestId("backing-record")
      .selectOption({ label: "Update: Sign-up is live" });
    await b.getByTestId("backing-confirm-post").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(1);
    expect(chain.sent[0].to).toBe(FIXTURE.pool);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0xfb03aded"); // postMilestone(bytes32)
    expect(chain.sent[0].data.slice(10)).toBe(updates[0].id);
  });

  test("a founder with no record to point at is told so, and a founder who must wait sees the date", async ({
    page,
  }) => {
    await open(page, {
      pool: { ...POOL_DEFAULTS, nextClaimIn: -DAY },
      as: "founder",
      wallet: FIXTURE.founderWallet,
    });
    await block(page).getByTestId("backing-post").click({ timeout: 30_000 });
    await expect(block(page).getByTestId("backing-no-records")).toContainText(
      "There is no record to point at yet.",
      {
        timeout: 20_000,
      },
    );
    await expect(
      block(page).getByTestId("backing-confirm-post"),
    ).toBeDisabled();
  });

  test("a founder cannot post before the date, and is told when", async ({
    page,
  }) => {
    await open(page, {
      pool: { ...POOL_DEFAULTS, nextClaimIn: 3 * DAY },
      as: "founder",
      wallet: FIXTURE.founderWallet,
    });
    await expect(block(page).getByTestId("backing-wait")).toContainText(
      "The next milestone can be posted from",
      {
        timeout: 30_000,
      },
    );
    await expect(block(page).getByTestId("backing-post")).toHaveCount(0);
  });

  test("an opening round shows its minimum and time, takes a bid on its own price grid, and sends the bid steps", async ({
    page,
  }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      phase: "waiting",
      roundBlocksLeft: 6_000,
    };
    const { chain } = await open(page, { pool, as: "visitor" });
    const b = block(page);
    await expect(b.getByTestId("backing-chip")).toHaveText("Opening round", {
      timeout: 30_000,
    });
    await expect(b.getByTestId("backing-round-minimum")).toHaveText(
      "2,500 tTEST",
    );
    await expect(b.getByTestId("backing-round-raised")).toHaveText("900 tTEST");
    await expect(b.getByTestId("backing-round-ends")).toContainText(
      "The round ends in about",
    );
    await expect(b.getByTestId("backing-state")).toContainText(
      "nobody wins by being first",
    );
    await b.getByTestId("backing-bid").click();
    await b.getByTestId("backing-confirm-bid").click();
    await expect(b.getByTestId("backing-problem")).toContainText(
      "Enter how much to bid",
    );
    await b.getByTestId("backing-bid-amount").fill("20");
    await b.getByTestId("backing-bid-price").fill("0.000001");
    await b.getByTestId("backing-confirm-bid").click();
    await expect(b.getByTestId("backing-problem")).toContainText(
      "has to be above the round's price now",
    );
    expect(chain.sent).toHaveLength(0);
    await b.getByTestId("backing-bid-price").fill("0.0001");
    await b.getByTestId("backing-confirm-bid").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(3);
    expect(chain.sent[0].to).toBe(FIXTURE.token); // approve Permit2
    expect(chain.sent[1].to).toBe("0x000000000022d473030f116ddee9f6b43ac78ba3"); // Permit2 approves the auction
    expect(chain.sent[2].to).toBe(FIXTURE.auction); // submitBid
  });

  test("a round that has ended can be settled by anyone", async ({ page }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      phase: "waiting",
      roundBlocksLeft: -10,
    };
    const { chain } = await open(page, { pool, as: "visitor" });
    const b = block(page);
    await expect(b.getByTestId("backing-round-ended")).toBeVisible({
      timeout: 30_000,
    });
    await expect(b.getByTestId("backing-bid")).toHaveCount(0);
    await b.getByTestId("backing-settle-round").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(1);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0x54076e89"); // seedFromAuction()
  });

  test("a bidder whose round opened backing exchanges the round tokens for units", async ({
    page,
  }) => {
    // The round settled: the pool is live, and this wallet still holds 5 round tokens.
    const { chain } = await open(page, {
      pool: { ...POOL_DEFAULTS, holderClaimTokens: 5n * UNIT },
      as: "visitor",
    });
    const b = block(page);
    await expect(b.getByTestId("backing-redeem")).toContainText(
      "You hold 5 round tokens",
      { timeout: 30_000 },
    );
    await b.getByTestId("backing-redeem-button").click();
    await expect.poll(() => chain.sent.length, { timeout: 20_000 }).toBe(1);
    expect(chain.sent[0].to).toBe(FIXTURE.pool);
    expect(chain.sent[0].data.slice(0, 10)).toBe("0xdb006a75"); // redeem(uint256)
    expect(BigInt(`0x${chain.sent[0].data.slice(-64)}`)).toBe(5n * UNIT);
    // Their bids in the round are the existing panel, in the round's own words and the token's own units.
    await b
      .getByTestId("backing-bids-disclosure")
      .getByText("Your bids in the opening round")
      .click();
    await expect(b.getByTestId("mybids-panel")).toContainText(
      "This account has no bids",
    );
  });

  test("a round that did not reach its minimum says everyone takes their money back", async ({
    page,
  }) => {
    await open(page, {
      pool: { ...POOL_DEFAULTS, phase: "failed" },
      as: "visitor",
    });
    await expect(block(page).getByTestId("backing-chip")).toHaveText(
      "Round not reached",
      { timeout: 30_000 },
    );
    await expect(block(page).getByTestId("backing-state")).toContainText(
      "takes their money back",
    );
    await expect(block(page).getByTestId("backing-back")).toHaveCount(0);
  });

  test("an abandoned project says backing closed for good and offers only to sell", async ({
    page,
  }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      phase: "abandoned",
      holderUnits: 4_000_000n * UNIT,
      holderSellValue: 90n * ONE,
      holderEscrow: 10n * ONE,
    };
    await open(page, { pool, as: "visitor" });
    const b = block(page);
    await expect(b.getByTestId("backing-chip")).toHaveText("Closed for good", {
      timeout: 30_000,
    });
    await expect(b.getByTestId("backing-state")).toContainText(
      "get their held money back",
    );
    await expect(b.getByTestId("backing-back")).toHaveCount(0);
    await expect(b.getByTestId("backing-sell")).toHaveText(
      "Sell and take my held money back",
    );
  });

  test("a first read that fails says so and tries again on request, never that there is no backing", async ({
    page,
  }) => {
    const relay = createMockRelay();
    seed(relay);
    await install(page, relay, VISITOR_KEY);
    const chain = await installBackingChain(page, {
      pool: { ...POOL_DEFAULTS },
      wallet: null,
      down: true,
    });
    await page.goto(PROJECT);
    const b = block(page);
    await expect(b.getByTestId("backing-unreadable")).toContainText(
      "Couldn't read how backing stands",
      {
        timeout: 30_000,
      },
    );
    await expect(b).not.toContainText("Backing is not open");
    chain.setDown(false);
    await b.getByRole("button", { name: "Try again" }).click();
    await expect(b.getByTestId("backing-held")).toHaveText("220 tTEST", {
      timeout: 30_000,
    });
  });

  test("a later read that fails keeps what was shown and says it may be old", async ({
    page,
  }) => {
    await page.clock.install({ time: Date.now() });
    const { chain } = await open(page, {
      pool: { ...POOL_DEFAULTS },
      as: "visitor",
      wallet: null,
    });
    await expect(block(page).getByTestId("backing-held")).toHaveText(
      "220 tTEST",
      { timeout: 30_000 },
    );
    chain.setDown(true);
    await page.clock.fastForward(60_000);
    await expect(block(page).getByTestId("backing-stale")).toContainText(
      "may be out of date",
      { timeout: 30_000 },
    );
    await expect(block(page).getByTestId("backing-held")).toHaveText(
      "220 tTEST",
    );
    chain.setDown(false);
    await block(page)
      .getByTestId("backing-stale")
      .getByRole("button", { name: "Try again" })
      .click();
    await expect(block(page).getByTestId("backing-stale")).toHaveCount(0, {
      timeout: 30_000,
    });
  });

  test("a project whose start no kit confirms shows no pool and puts no money anywhere", async ({
    page,
  }) => {
    const { chain } = await open(page, {
      pool: { ...POOL_DEFAULTS },
      as: "visitor",
      kitMadeDao: null,
    });
    await expect(block(page).getByTestId("backing-state")).toContainText(
      "We could not confirm that this project was made here",
      { timeout: 30_000 },
    );
    await expect(block(page).getByRole("button")).toHaveCount(0);
    expect(chain.asked).toHaveLength(0);
  });

  test("the public scorecard shows the same facts and no buttons, and points at the project's page", async ({
    page,
  }) => {
    await open(page, {
      pool: { ...POOL_DEFAULTS },
      as: "signed-out",
      wallet: null,
      path: SCORECARD,
    });
    const b = block(page);
    await expect(b.getByTestId("backing-held")).toHaveText("220 tTEST", {
      timeout: 30_000,
    });
    await expect(b.getByRole("button")).toHaveCount(0);
    await expect(
      b.getByRole("link", { name: "See backing on the project's page" }),
    ).toBeVisible();
    await expect(b).not.toContainText(/price|returns?\b|profit/i);
  });

  test("on a phone nothing scrolls sideways, and every control is a full tap target", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      holderUnits: 4_000_000n * UNIT,
      holderSellValue: 90n * ONE,
      holderEscrow: 10n * ONE,
      windowEndsIn: 5 * DAY,
      holderCanLeave: true,
      holderLeaveValue: 99n * ONE,
    };
    await open(page, { pool, as: "visitor" });
    const b = block(page);
    await b.getByTestId("backing-back").click({ timeout: 30_000 });
    await b.getByTestId("backing-amount").fill("10");
    await expect(b.getByTestId("backing-plan")).toContainText("You get about", {
      timeout: 15_000,
    });
    await expectNoSidewaysScroll(page, "the Backing block on a phone");
    for (const id of [
      "backing-back",
      "backing-sell",
      "backing-leave",
      "backing-amount",
      "backing-confirm-back",
    ]) {
      const box = await b.getByTestId(id).boundingBox();
      expect(box?.height ?? 0, `${id} height`).toBeGreaterThanOrEqual(44);
    }
    await expectAccessible(page, "the Backing block on a phone");
  });

  test("the Backing block has no serious accessibility violations on a desktop", async ({
    page,
  }) => {
    const pool: PoolFixture = {
      ...POOL_DEFAULTS,
      holderUnits: 4_000_000n * UNIT,
      holderSellValue: 90n * ONE,
      holderEscrow: 10n * ONE,
      events: [
        postedEvent(1n, "e".padEnd(64, "1"), FIXTURE.founderWallet, 20),
        resolvedEvent(1n, true, 55n * ONE, 21),
      ],
    };
    await open(page, { pool, as: "visitor" });
    await expect(block(page).getByTestId("backing-held")).toBeVisible({
      timeout: 30_000,
    });
    await block(page).getByTestId("backing-back").click();
    await expectAccessible(page, "the Backing block");
  });
});

test.describe("Home's feed", () => {
  test.skip(
    BUILD !== "on",
    "needs the investing build: run scripts/web-investing-mock-e2e.sh",
  );

  const feedPool = (): PoolFixture => ({
    ...POOL_DEFAULTS,
    events: [
      boughtEvent(FIXTURE.backerWallet, 100n * ONE, 1_000n, 10),
      boughtEvent(FIXTURE.founderWallet, 50n * ONE, 1_100n, 11),
      postedEvent(1n, "e".padEnd(64, "1"), FIXTURE.founderWallet, 20),
    ],
  });

  test("backing shows below the project's records as quiet one-line cards, with the price line only on a day's buys", async ({
    page,
  }) => {
    await open(page, {
      pool: feedPool(),
      as: "visitor",
      wallet: null,
      updates: [update("Sign-up is live", now() - 3 * DAY)],
      path: "/?tab=updates",
    });
    const feed = page.getByTestId("record-feed");
    await expect(feed.getByTestId("record-card").first()).toBeVisible({
      timeout: 30_000,
    });
    const cards = page.getByTestId("backing-feed-card");
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    await expect(
      cards.filter({ has: page.locator("[data-kind=backed]") }),
    ).toHaveCount(0);
    await expect(
      page.locator("[data-testid=backing-feed-card][data-kind=backed]"),
    ).toContainText("Backed Docs Commons: 2 backers · 150 tTEST paid in");
    await expect(
      page.locator(
        "[data-testid=backing-feed-card][data-kind=milestone-posted]",
      ),
    ).toContainText("Docs Commons posted a milestone. Backers can leave until");
    // Below the records, never above them.
    const order = await page.evaluate(() => {
      const record = document.querySelector("[data-testid=record-card]");
      const backing = document.querySelector("[data-testid=backing-feed]");
      return record && backing ? record.compareDocumentPosition(backing) : 0;
    });
    expect(order & 4, "backing follows the first record card").toBeTruthy();
    // No price line on any card but the buys.
    await expect(
      page.locator("[data-kind=milestone-posted]"),
    ).not.toContainText(/price/i);
    await expectAccessible(page, "Home's feed with backing");
  });

  test("a feed read that fails for a project says so, and a retry brings the cards", async ({
    page,
  }) => {
    const { chain } = await open(page, {
      pool: feedPool(),
      as: "visitor",
      wallet: null,
      down: true,
      updates: [update("Sign-up is live", now() - 3 * DAY)],
      path: "/?tab=updates",
    });
    await expect(page.getByTestId("backing-feed-failed")).toContainText(
      "Couldn't read backing for 1 project",
      {
        timeout: 30_000,
      },
    );
    await expect(page.getByTestId("backing-feed-card")).toHaveCount(0);
    chain.setDown(false);
    await page
      .getByTestId("backing-feed-failed")
      .getByRole("button", { name: "Try again" })
      .click();
    await expect(page.getByTestId("backing-feed-card")).toHaveCount(2, {
      timeout: 30_000,
    });
  });
});

test.describe("the switch is off", () => {
  test.skip(
    BUILD !== "off",
    "needs the build that names the addresses and leaves the switch unset",
  );

  test("a build that names the pool factory and the token but not the switch shows no Backing block and asks the chain nothing", async ({
    page,
  }) => {
    const { chain } = await open(page, {
      pool: { ...POOL_DEFAULTS },
      as: "visitor",
    });
    // The project page is up: its record cards are there, and backing is not.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Docs Commons",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("project-goal")).toBeVisible();
    await expect(page.getByTestId("backing")).toHaveCount(0);
    await expect(page.getByText("Backing", { exact: true })).toHaveCount(0);
    await page.goto(SCORECARD);
    await expect(page.getByTestId("scorecard")).toBeVisible();
    await expect(page.getByTestId("backing")).toHaveCount(0);
    expect(
      chain.asked,
      "the factory was asked about a pool with investing off",
    ).toEqual([]);
  });
});
