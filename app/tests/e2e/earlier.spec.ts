import { expect, type Page, test } from "@playwright/test";
import {
  claimFragment,
  consentData,
  fingerprintOf,
  leafOf,
} from "../../../packages/creaton-core/src/launchpad/earlier-claim.ts";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import {
  BACKER_EVM,
  CONTRACTS,
  numbersContent,
} from "../helpers/numbers-fixture";
import { PressCounter } from "../helpers/press-counter";
import { addressWord, installChainWallet, word } from "./helpers/chain-wallet";
import { RELAY, sentCalls } from "./helpers/money-world";
import { COORD, KEY, MATE_KEY } from "./helpers/team-world";
import { event, install, now } from "./helpers/world";
import { createMockRelay } from "./mock-relay";

/**
 * An earlier backer's page (plan v2 milestone 7, scope 5): a link's own line, the agreement shown when its fingerprints
 * are the contract's, and one agreement in 2 presses with nothing typed. The wallet is a stand-in that answers the list's
 * reads and records what it is sent. Every holder, amount and salt is made up.
 */
const CLAIM = "0x5c0000000000000000000000000000000000c1a1";
const SALT = `0x${"11".repeat(32)}`;
const AMOUNT = 5_000_000_000_000_000_000n;
const ENTRY = 2n;
const TEXT = "Made-up agreement text for the browser journey.";
const SUMMARY = "Made-up one-line summary for the browser journey.";
const LINK = `/earlier${claimFragment({ entry: ENTRY, holder: BACKER_EVM, amount: AMOUNT, salt: SALT })}`;

function seedList(relay: ReturnType<typeof createMockRelay>) {
  const content = numbersContent({ coordinate: COORD, now: now() });
  relay.seed(
    event(
      39009,
      RELAY,
      {
        ...content,
        earlierBackers: {
          claim: CLAIM,
          bound: true,
          textVersion: 1,
          consented: { count: 3, total: "15000000000000000000" },
          voidedCount: 0,
          delivered: { count: 0, total: "0" },
          replacements: { pending: 0, done: 0, cancelled: 0 },
          listClosed: null,
          sentToReserve: "0",
        },
      },
      [
        ["d", KEY],
        ["chain", "31337"],
        ["launcher", CONTRACTS.launcher],
      ],
      now(),
    ),
  );
}

const reads = (): Record<string, string> => ({
  "textHash()": `0x${word(BigInt(fingerprintOf(TEXT)))}`,
  "summaryHash()": `0x${word(BigInt(fingerprintOf(SUMMARY)))}`,
  "textVersion()": `0x${word(1)}`,
  "key()": `0x${word(BigInt(KEY))}`,
  "closed()": `0x${word(0)}`,
  "closeAt()": `0x${word(now() + 400 * 86_400)}`,
  "total()": `0x${word(AMOUNT * 4n)}`,
  "funding()": `0x${word(AMOUNT * 4n)}`,
  "entryCount()": `0x${word(21)}`,
  "leaf(uint256)": leafOf(ENTRY, BACKER_EVM, AMOUNT, SALT),
  "entryOf(uint256)": `0x${[
    addressWord(`0x${"0".repeat(40)}`),
    word(0),
    word(0),
    addressWord(`0x${"0".repeat(40)}`),
    word(0),
    word(0),
    addressWord(`0x${"0".repeat(40)}`),
    addressWord(`0x${"0".repeat(40)}`),
    addressWord(`0x${"0".repeat(40)}`),
    word(0),
    word(0),
  ].join("")}`,
  "due(uint256)": `0x${word(0)}`,
});

async function open(page: Page, text: "ok" | "missing" = "ok") {
  const relay = createMockRelay();
  seedList(relay);
  await install(page, relay, MATE_KEY, { investing: true, relaySelf: RELAY });
  await installChainWallet(page, { account: BACKER_EVM, reads: reads() });
  await page.route("**/earlier-text.json", (route) =>
    text === "ok"
      ? route.fulfill({
          status: 200,
          json: { version: 1, text: TEXT, summary: SUMMARY },
        })
      : route.fulfill({ status: 404, body: "" }),
  );
  await page.goto(LINK);
}

test("an earlier backer agrees in 2 presses and nothing typed", async ({
  page,
}) => {
  await open(page);
  const text = page.getByTestId("earlier-text");
  await expect(text).toBeVisible({ timeout: 20_000 });
  await expect(text).toHaveValue(TEXT);
  const path = new PressCounter();
  await path.read(page, "Your line", page.getByTestId("earlier-line"));
  await path.tick(page.getByTestId("earlier-read"), "I have read all of this");
  await path.press(page.getByTestId("earlier-agree"), "Agree with my wallet");
  await expect(page.getByText("You agreed.")).toBeVisible();
  const sent = await sentCalls(page);
  expect(sent.length).toBe(1);
  expect(sent[0].from).toBe(BACKER_EVM);
  expect(sent[0].to).toBe(CLAIM);
  // The contract's own `consent`, in person, to the holder, for the text read (the deadline word is the page's clock).
  const expected = consentData({
    entry: ENTRY,
    holder: BACKER_EVM,
    amount: AMOUNT,
    salt: SALT,
    receiver: BACKER_EVM,
    textHash: fingerprintOf(TEXT),
    validUntil: 0n,
  });
  const strip = (data: string) =>
    data.slice(0, 2 + 8 + 64 * 6) + data.slice(2 + 8 + 64 * 7);
  expect(strip(sent[0].data)).toBe(strip(expected));
  // The design's budget for a signed-in earlier backer on a computer: 2 presses, nothing typed.
  console.log(path.summary("Agree (earlier backer)"));
  expect(path.presses).toBeLessThanOrEqual(2);
  expect(path.fields).toBe(0);
});

test("without a published agreement nothing can be agreed", async ({
  page,
}) => {
  await open(page, "missing");
  await expect(page.getByTestId("earlier-text-missing")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("earlier-agree")).toHaveCount(0);
});

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

for (const size of WIDTHS)
  for (const scheme of ["dark", "light"] as const)
    test(`the earlier backer's page is accessible (${size.width}, ${scheme})`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await page.getByTestId("earlier-text").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(400);
      await expectNoSidewaysScroll(page, `Earlier, ${scheme}`);
      await expectAccessible(page, `Earlier, ${scheme}`);
      await page.getByRole("radio").nth(1).check();
      await page.getByTestId("earlier-receiver").waitFor();
      await expectAccessible(page, `Earlier with another wallet, ${scheme}`);
    });
