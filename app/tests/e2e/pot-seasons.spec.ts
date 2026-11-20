import { expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  chainIdentityV2,
  numbersV2Content,
} from "../helpers/numbers-v2-fixture";
import { inSeasonOrder } from "../../src/features/season/season-order";
import { createMockRelay } from "./mock-relay";
import { RELAY } from "./helpers/money-world";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  projectLink,
  projectRecord,
  pubkeyOf,
} from "./helpers/world";

/**
 * Seasons in a real browser against the mock server (plan sections 5 and 7.7): the band on Home in each state, a founder
 * entering a project and taking it out, a refusal in plain words, and the demo day page with its cards in the hashed order, 24
 * at a time, the banner once and the line under the list's heading. No chain is needed: the page reads only records.
 */

const OPERATOR = pubkeyOf("a1".repeat(32));
const FOUNDER_KEY = "d1".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const STRANGER_KEY = "d2".repeat(32);
const BANNER =
  "You can take your money out any time. Nothing here promises a profit.";
const NOT_A_RETURN = "This can go up or down. It is not a return.";
const PHONE = { width: 360, height: 640 };

type Relay = ReturnType<typeof createMockRelay>;

/** A project the founder launched: its record, with the launch it names, and the server's numbers for it. */
function launched(relay: Relay, founder: string, id: string, name: string) {
  const key = chainIdentityV2(coordOf(founder, id)).key;
  relay.seed(
    projectRecord(founder, id, name, `What ${name} makes.`, now() - 20 * DAY, [
      ["chain-key", key],
    ]),
  );
  relay.seed(
    event(
      39009,
      RELAY,
      numbersV2Content({ coordinate: coordOf(founder, id), now: now() }),
      [["d", key]],
      now() - 60,
    ),
  );
}

function season(
  relay: Relay,
  n: number,
  start: number,
  demo: number,
  end: number,
) {
  relay.seed(
    event(
      37021,
      OPERATOR,
      {
        v: 1,
        number: n,
        startsAt: now() + start * DAY,
        demoDayAt: now() + demo * DAY,
        endsAt: now() + end * DAY,
      },
      [["d", `season-${n}`]],
      now() - 50 * DAY,
    ),
  );
}

const step = (
  n: number,
  founder: string,
  id: string,
  family: "entry" | "leave" | "remove",
  signer: string,
  ago: number,
) =>
  event(
    47003,
    signer,
    {},
    [
      ["a", coordOf(founder, id)],
      ["t", `season-${n}`],
      [`season-${family}`, String(n)],
    ],
    now() - ago,
  );

async function openPage(
  page: Page,
  relay: Relay,
  key: string | null,
  path = "/",
) {
  await install(page, relay, key, { investing: true, relaySelf: RELAY });
  await page.goto(path);
}

const phone = (browser: import("@playwright/test").Browser) =>
  browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

/** Founders that are not the signed-in one: each project of the demo day has its own. */
const founderN = (n: number) =>
  pubkeyOf(n.toString(16).padStart(2, "0").repeat(32));

test("the band on Home in demo week, and the demo day page it leads to, at 360 by 640", async ({
  browser,
}) => {
  const relay = createMockRelay();
  season(relay, 1, -43, -1, 6);
  const names = ["Alder", "Birch", "Cedar", "Dogwood", "Elm"];
  names.forEach((name, i) => {
    launched(relay, founderN(i + 1), `p${i + 1}`, name);
  });
  // Alder, Birch and Cedar are in. Dogwood entered and left. Elm entered and was taken out by the people who run the server.
  for (const i of [1, 2, 3, 4, 5])
    relay.seed(step(1, founderN(i), `p${i}`, "entry", founderN(i), 5_000 + i));
  relay.seed(step(1, founderN(4), "p4", "leave", founderN(4), 1_000));
  relay.seed(step(1, founderN(5), "p5", "remove", OPERATOR, 900));
  relay.seed(
    event(
      47003,
      founderN(1),
      { title: "Lids painted", body: "All forty lids are painted." },
      [["a", coordOf(founderN(1), "p1")]],
      now() - 3 * 3_600,
    ),
  );
  const context = await phone(browser);
  const page = await context.newPage();
  await openPage(page, relay, null);
  const band = page.getByRole("region", { name: "Seasons" });
  await expect(band.getByTestId("season-band-words")).toHaveText(
    "Demo day: 3 projects show what they made.",
  );
  await expectNoSidewaysScroll(page, "Home with the season band");
  await band.getByRole("link", { name: "See demo day" }).click();
  await expect(page).toHaveURL(/\/season\/1$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Season 1");

  // The cards: the three that are in, in the order the hash gives, never an order of money or of entry.
  const cards = page.getByTestId("demo-card");
  await expect(cards).toHaveCount(3, { timeout: 20_000 });
  const inOrder = inSeasonOrder(
    1,
    [1, 2, 3].map((i) => coordOf(founderN(i), `p${i}`)),
  ).map((c) => names[Number(/p(\d)$/.exec(c)?.[1]) - 1]);
  await expect(cards.getByRole("heading")).toHaveText(inOrder);
  // The first project's card says its money and its last update.
  const alder = cards.filter({ hasText: "Alder" });
  await expect(alder.getByTestId("demo-money")).toContainText(
    /^The project's money [0-9,]+/,
  );
  await expect(alder.getByTestId("demo-update")).toContainText("Lids painted");
  await expect(alder.getByTestId("demo-update")).toContainText(
    "All forty lids are painted.",
  );
  const cedar = cards.filter({ hasText: "Cedar" });
  await expect(cedar.getByTestId("demo-update")).toHaveText("No update yet.");

  // The words the plan fixes: the line once under the list's heading, the banner once, the play-money line and the note.
  const list = page.getByTestId("demo-list");
  await expect(list.getByText(NOT_A_RETURN)).toHaveCount(1);
  await expect(page.getByText(BANNER)).toHaveCount(1);
  await expect(page.getByTestId("shell-banner")).toHaveCount(0);
  await expect(page.getByTestId("demo-play-money")).toContainText("play money");
  await expect(page.getByTestId("demo-not-advice")).toHaveText(
    "Being on this page is not advice and is not a promise.",
  );
  const text = (await page.getByTestId("season-page").textContent()) ?? "";
  expect(text).not.toMatch(/price|volume|per share|joined|took out/i);
  await expectNoSidewaysScroll(page, "the demo day page at 360");
  await expectAccessible(page, "the demo day page");

  // The only press on a card is "Open project", named for the project, reached and used by the keyboard alone.
  const openAlder = page.getByRole("link", { name: "Open project Alder" });
  await openAlder.focus();
  await expect(openAlder).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`${projectLink(founderN(1), "p1")}$`),
  );
  await context.close();
});

test("24 at a time: Show more brings the next and puts the keyboard on the first new card", async ({
  browser,
}) => {
  const relay = createMockRelay();
  season(relay, 2, -43, -1, 6);
  for (let i = 1; i <= 30; i += 1) {
    launched(
      relay,
      founderN(i),
      `q${i}`,
      `Project ${String.fromCharCode(64 + i)}`,
    );
    relay.seed(step(2, founderN(i), `q${i}`, "entry", founderN(i), 5_000 + i));
  }
  const context = await phone(browser);
  const page = await context.newPage();
  await openPage(page, relay, null, "/season/2");
  const cards = page.getByTestId("demo-card");
  await expect(cards).toHaveCount(24, { timeout: 20_000 });
  await page.getByTestId("demo-more").click();
  await expect(cards).toHaveCount(30, { timeout: 20_000 });
  await expect(page.getByTestId("demo-more")).toHaveCount(0);
  await expect(cards.nth(24).getByRole("link")).toBeFocused();
  await expectNoSidewaysScroll(page, "the demo day page with 30 projects");
  await context.close();
});

test("a founder enters a project and takes it out; a refusal is said in plain words and the press stays", async ({
  browser,
}) => {
  const relay = createMockRelay({
    refuse: (e) =>
      e.tags.some((t) => t[0] === "season-entry") && refusing
        ? "restricted: this season is full"
        : null,
  });
  let refusing = false;
  season(relay, 3, -3, 39, 46);
  launched(relay, FOUNDER, "moss", "Moss");
  launched(relay, FOUNDER, "fern", "Fern");
  const context = await phone(browser);
  const page = await context.newPage();
  await openPage(page, relay, FOUNDER_KEY);
  const band = page.getByRole("region", { name: "Seasons" });
  await expect(band.getByTestId("season-band-words")).toContainText(
    "Season 3 is open. Projects can enter until demo day on",
  );
  await expect(band.getByRole("button", { name: "Enter Fern" })).toBeVisible();
  await band.getByRole("button", { name: "Enter Moss" }).click();
  await expect(band.getByText("Moss is in.")).toBeVisible();
  await expect(band.getByRole("button", { name: "Leave Moss" })).toBeVisible();
  const entered = relay.events.filter((e) =>
    e.tags.some((t) => t[0] === "season-entry"),
  );
  expect(entered).toHaveLength(1);
  expect(entered[0].tags).toEqual([
    ["a", coordOf(FOUNDER, "moss")],
    ["t", "season-3"],
    ["season-entry", "3"],
  ]);
  await expectAccessible(page, "Home with the season band open");
  await expectNoSidewaysScroll(page, "Home with the season band open");

  // What was read from the server stays: a reload shows it in.
  await page.reload();
  await expect(page.getByRole("button", { name: "Leave Moss" })).toBeVisible();
  await page.getByRole("button", { name: "Leave Moss" }).click();
  await expect(page.getByRole("button", { name: "Enter Moss" })).toBeVisible();

  // A refusal: said in plain words, nothing of the server's own text, and the press is still there.
  refusing = true;
  await page.getByRole("button", { name: "Enter Fern" }).click();
  await expect(page.getByTestId("season-problem")).toHaveText(
    "This season is full.",
  );
  await expect(page.getByRole("button", { name: "Enter Fern" })).toBeVisible();
  expect(
    await page.getByRole("region", { name: "Seasons" }).textContent(),
  ).not.toMatch(/restricted/);
  await context.close();
});

test("a visitor and a person with no project of their own are offered nothing to press; no season record, no band", async ({
  browser,
}) => {
  const relay = createMockRelay();
  season(relay, 4, -3, 39, 46);
  launched(relay, FOUNDER, "moss", "Moss");
  const context = await phone(browser);
  const page = await context.newPage();
  await openPage(page, relay, null);
  await expect(page.getByTestId("season-band-words")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Seasons" }).getByRole("button"),
  ).toHaveCount(0);
  await openPage(page, relay, STRANGER_KEY);
  await expect(page.getByTestId("season-band-words")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Seasons" }).getByRole("button"),
  ).toHaveCount(0);
  await context.close();

  const bare = createMockRelay();
  launched(bare, FOUNDER, "moss", "Moss");
  const second = await phone(browser);
  const home = await second.newPage();
  await openPage(home, bare, FOUNDER_KEY);
  await expect(home.getByTestId("home-projects")).toBeVisible();
  await expect(home.getByTestId("season-band")).toHaveCount(0);
  await second.close();
});

test("the demo day page at 390 and 1280 does not scroll sideways, and a season that does not exist says so", async ({
  browser,
}) => {
  const relay = createMockRelay();
  season(relay, 5, -43, -1, 6);
  for (let i = 1; i <= 3; i += 1) {
    launched(
      relay,
      founderN(i),
      `r${i}`,
      `A project with a rather long name number ${i}`,
    );
    relay.seed(step(5, founderN(i), `r${i}`, "entry", founderN(i), 4_000 + i));
  }
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    const page = await context.newPage();
    await openPage(page, relay, null, "/season/5");
    await expect(page.getByTestId("demo-card")).toHaveCount(3, {
      timeout: 20_000,
    });
    await expectNoSidewaysScroll(page, `the demo day page at ${width}`);
    await openPage(page, relay, null, "/season/99");
    await expect(
      page.getByText("This season could not be found on this server."),
    ).toBeVisible();
    await openPage(page, relay, null, "/season/not-a-number");
    await expect(
      page.getByText("This season could not be found on this server."),
    ).toBeVisible();
    await context.close();
  }
});
