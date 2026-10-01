import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The portfolio: your share of the accepted work (only a reviewer other than
 * you makes work count), the raises you backed read from your wallet's bids
 * on chain (a raise whose bids could not be read says so, never "none"), and
 * the launches you follow.
 */

const ME_NSEC = "5".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(ME_NSEC, "hex")));
const ADMIN = "a".repeat(64);
const ALICE = "b".repeat(64);
const FOUNDER = "c".repeat(64);
const WALLET = `0x${"12".repeat(20)}`;
const NEBULA_AUCTION = `0x${"aa".repeat(20)}`;
const COMET_AUCTION = `0x${"bb".repeat(20)}`;
const QUIET_AUCTION = `0x${"cc".repeat(20)}`;

const TOPIC_BID_SUBMITTED =
  "0x650baad5cd8ca09b8f580be220fa04ce2ba905a041f764b6a3fe2c848eb70540";
const SELECTOR_BIDS = "0x4423c5f1";
const SELECTOR_IS_GRADUATED = "0x9e5f2602";
const SELECTOR_CURRENCY_RAISED = "0x998ba4fc";
const Q96 = 2n ** 96n;
const ETHER = 10n ** 18n;

let seq = 0;
function event(fields: {
  kind: number;
  pubkey: string;
  tags?: string[][];
  content?: string;
  created_at?: number;
}) {
  seq += 1;
  return {
    id: `${seq.toString(16).padStart(8, "0")}${"d".repeat(56)}`,
    created_at: fields.created_at ?? 1_700_000_000 + seq,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...fields,
  };
}

function launch(d: string, name: string, auction: string | null, at: number) {
  const tags = [
    ["d", d],
    ["name", name],
    ["t", "dao-launchpad"],
    ["admission", "community"],
  ];
  if (auction) tags.push(["auction", auction]);
  return event({
    kind: 37001,
    pubkey: FOUNDER,
    tags,
    // A null currency is a native (ETH) sale.
    content: JSON.stringify({ pitch: `${name} pitch.`, stage: "live" }),
    created_at: at,
  });
}

function contribution(
  pubkey: string,
  d: string,
  at: number,
  body: Record<string, unknown>,
) {
  return event({
    kind: 37013,
    pubkey,
    tags: [["d", d]],
    content: JSON.stringify({ v: 1, action: d, ...body }),
    created_at: at,
  });
}

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addressWord = (address: string) =>
  address.toLowerCase().replace(/^0x/, "").padStart(64, "0");

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, ME_NSEC);
}

/**
 * A wallet that already granted this site its account (no prompt), and a
 * same-origin chain endpoint: Nebula holds one 1.5 ETH bid of ours in a 6 ETH
 * raise, Comet's chain reads fail, and the quiet raise has no bids of ours.
 */
async function installWalletAndChain(page: Page) {
  await page.addInitScript((address) => {
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts") return [address];
        if (method === "eth_chainId") return "0x14a34";
        throw new Error(`unexpected wallet call ${method}`);
      },
      on: () => {},
      removeListener: () => {},
    };
  }, WALLET);
  await page.route("**/test-rpc", async (route) => {
    const { id, method, params } = JSON.parse(
      route.request().postData() ?? "{}",
    ) as { id: number; method: string; params: Record<string, unknown>[] };
    const reply = (body: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
      });
    const target = String(
      params[0]?.address ?? params[0]?.to ?? "",
    ).toLowerCase();
    if (target === COMET_AUCTION) {
      return reply({ error: { code: -32000, message: "node unavailable" } });
    }
    if (method === "eth_blockNumber") return reply({ result: "0x10" });
    if (method === "eth_getLogs") {
      const topics = (params[0]?.topics ?? []) as (string | null)[];
      const mine = topics[2] === `0x${addressWord(WALLET)}`;
      const logs =
        target === NEBULA_AUCTION
          ? [
              {
                address: NEBULA_AUCTION,
                topics: [
                  TOPIC_BID_SUBMITTED,
                  `0x${word(1n)}`,
                  `0x${addressWord(WALLET)}`,
                ],
                data: "0x",
              },
            ]
          : [];
      return reply({ result: mine || topics.length === 1 ? logs : [] });
    }
    if (method === "eth_call") {
      const data = String(params[0]?.data ?? "");
      if (target !== NEBULA_AUCTION) return reply({ result: `0x${word(0n)}` });
      if (data.startsWith(SELECTOR_BIDS)) {
        return reply({
          result: `0x${[
            word(1n),
            word(0n),
            word(0n),
            word(Q96),
            addressWord(WALLET),
            word(((3n * ETHER) / 2n) * Q96),
            word(0n),
          ].join("")}`,
        });
      }
      if (data.startsWith(SELECTOR_IS_GRADUATED)) {
        return reply({ result: `0x${word(0n)}` });
      }
      if (data.startsWith(SELECTOR_CURRENCY_RAISED)) {
        return reply({ result: `0x${word(6n * ETHER)}` });
      }
      return reply({ result: `0x${word(0n)}` });
    }
    return reply({ error: { code: -32601, message: `no ${method}` } });
  });
}

function seedOrg(relay: ReturnType<typeof createMockRelay>) {
  // The admin owns the org root, so their reviews count.
  relay.seed(
    event({
      kind: 37010,
      pubkey: ADMIN,
      tags: [["d", "root"]],
      content: JSON.stringify({ name: "Org", holders: [ADMIN], scope: {} }),
    }),
  );
}

test("your share of the work counts only what a reviewer accepted, and Following lists your launches", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedOrg(relay);
  // Mine, accepted at 30 points.
  relay.seed(contribution(ME, "docs", 100, { amount: 30 }));
  relay.seed(
    contribution(ADMIN, "docs", 110, { amount: 30, reviewStatus: "accepted" }),
  );
  // Mine, waiting for a reviewer.
  relay.seed(contribution(ME, "tests", 120, { amount: 10 }));
  // Mine, "accepted" only by myself: still waiting, earns nothing.
  relay.seed(contribution(ME, "logo", 130, { amount: 50 }));
  relay.seed(
    contribution(ME, "logo", 131, { amount: 50, reviewStatus: "accepted" }),
  );
  // Alice's, accepted at 90 points.
  relay.seed(contribution(ALICE, "api", 100, { amount: 90 }));
  relay.seed(
    contribution(ADMIN, "api", 110, { amount: 90, reviewStatus: "accepted" }),
  );
  // A followed launch (no sale contract yet) and one we don't follow.
  relay.seed(launch("nebula", "Nebula DAO", null, 1_700_000_500));
  relay.seed(launch("comet", "Comet Co", null, 1_700_000_501));
  relay.seed(
    event({
      kind: 10003,
      pubkey: ME,
      tags: [["a", `37001:${FOUNDER}:nebula`]],
    }),
  );
  await relay.install(page);
  await signIn(page);
  await page.goto("/");
  await page.getByTestId("app-nav-portfolio").click();
  await expect(page).toHaveURL(/\/portfolio$/);

  const work = page.getByTestId("portfolio-work");
  await expect(work.getByTestId("portfolio-work-points")).toHaveText("30");
  await expect(work.getByTestId("portfolio-work-share")).toHaveText("25%");
  await expect(work.getByTestId("portfolio-work-counts")).toHaveText(
    "1 piece accepted · 2 waiting for review",
  );

  // No wallet in this browser: ask to connect, never claim "no raises".
  await expect(page.getByTestId("portfolio-backing-no-wallet")).toBeVisible();

  const followed = page.getByTestId("portfolio-followed");
  await expect(followed).toHaveCount(1);
  await expect(followed).toContainText("Nebula DAO");
});

test("raises you backed come from your wallet's bids, and a raise that can't be read says so", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(launch("nebula", "Nebula DAO", NEBULA_AUCTION, 1_700_000_600));
  relay.seed(launch("comet", "Comet Co", COMET_AUCTION, 1_700_000_601));
  relay.seed(launch("quiet", "Quiet Labs", QUIET_AUCTION, 1_700_000_602));
  await relay.install(page);
  await installWalletAndChain(page);
  await signIn(page);
  await page.goto("/portfolio");

  const raises = page.getByTestId("portfolio-raise");
  await expect(raises).toHaveCount(1);
  await expect(raises.first()).toContainText("Nebula DAO");
  await expect(raises.first()).toContainText("You put in 1.5 ETH");
  // 1.5 of the 6 ETH raised.
  await expect(raises.first()).toContainText("25% of the raise");
  await expect(raises.first()).toContainText("1 bid still in the sale");

  // Comet's bids could not be read: unknown, not "you never backed it".
  await expect(page.getByTestId("portfolio-backing-failed")).toContainText(
    "Couldn't check your bids in Comet Co.",
  );
  await expect(page.getByTestId("portfolio-backing")).not.toContainText(
    "Quiet Labs",
  );
});

test("on a phone, Home links to the portfolio and the tab bar keeps five tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  await page.goto("/");
  await expect(page.getByTestId("app-nav-home")).toBeVisible();
  await expect(page.getByTestId("app-nav-portfolio")).toHaveCount(0);
  const nav = await page
    .getByTestId("app-nav")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(nav).toBe(0);

  await page.getByTestId("home-portfolio-link").click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Portfolio" }),
  ).toBeVisible();
});
