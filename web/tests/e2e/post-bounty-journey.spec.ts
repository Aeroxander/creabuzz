import { expect, test, type Page } from "@playwright/test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";

/**
 * Money behind a post (N2), entirely from the post's page, against a REAL local chain with the real `OpenBounty`.
 *
 * Opt-in: `scripts/web-post-bounty-e2e.sh` boots the chain, builds the app with the bounty contract named and runs
 * this. Each step is done in a page as the wallet of the person whose step it is: Ben puts money behind his post, Cara
 * adds some, Dev submits work, both back it, a dip stops the wait, the wait runs out and anyone pays; then a second
 * bounty nobody earns is refunded. Stubbed: the server (it only serves the post) and the wallets (`window.ethereum`
 * forwarding to Anvil's unlocked accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const BOUNTY = process.env.E2E_OPEN_BOUNTY ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const BEN = process.env.E2E_BEN ?? "";
const CARA = process.env.E2E_CARA ?? "";
const DEV = process.env.E2E_DEV ?? "";
const EVE = process.env.E2E_EVE ?? "";
const UNIT = 10n ** 6n;

test.skip(
  !ANVIL_URL || !BOUNTY || !CURRENCY,
  "set E2E_ANVIL_URL, E2E_OPEN_BOUNTY and E2E_CURRENCY (scripts/web-post-bounty-e2e.sh does)",
);

const AUTHOR_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const POST = finalizeEvent(
  {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000) - 600,
    tags: [],
    content: "Someone should paint the bike lane on Elm Street.",
  },
  AUTHOR_KEY,
);
const NSEC = "44".repeat(32);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/** Let time pass on the chain, the way waiting would. */
async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

const usdcOf = async (holder: string) =>
  BigInt(
    String(
      await rpc("eth_call", [
        {
          to: CURRENCY,
          data: `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`,
        },
        "latest",
      ]),
    ),
  );

type Filter = {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  "#e"?: string[];
};

/** A server that knows one post and answers every other question with nothing. */
function matches(event: typeof POST, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (
    filter["#e"] &&
    !event.tags.some((t) => t[0] === "e" && filter["#e"]?.includes(t[1]))
  ) {
    return false;
  }
  return true;
}

async function open(page: Page, wallet: string) {
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        const event = parsed[1] as { id: string };
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, ...filters] = parsed as [string, string, ...Filter[]];
      if (filters.some((f) => matches(POST, f))) {
        ws.send(JSON.stringify(["EVENT", subId, POST]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto(`/social/post/${POST.id}`);
  await expect(page.getByTestId("post-bounty")).toBeVisible({
    timeout: 30_000,
  });
}

const card = (page: Page) => page.getByTestId("post-bounty");
const item = (page: Page) => card(page).getByTestId("post-bounty-item").first();
const status = (page: Page) => item(page).getByTestId("post-bounty-status");

/** Re-read the page after the chain's clock moved. */
async function refresh(page: Page) {
  await page.reload();
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
}

test("money behind a post is paid to the work most of it backs for nine days, and a dip stops it in time", async ({
  context,
}) => {
  test.setTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 600_000));
  expect(getPublicKey(AUTHOR_KEY)).toBe(POST.pubkey);
  const devBefore = await usdcOf(DEV);

  // ── Ben puts 50 behind his own post ───────────────────────────────────────────────────────────
  const ben = await context.newPage();
  await open(ben, BEN);
  await expect(card(ben)).toContainText("None yet.", { timeout: 30_000 });
  await card(ben).getByTestId("post-bounty-open").click();
  await card(ben)
    .getByTestId("post-bounty-words-input")
    .fill("A photo of the painted lane on Elm Street, both ends.");
  await card(ben).getByTestId("post-bounty-amount").fill("50");
  await card(ben).getByTestId("post-bounty-submit").click();
  await expect(item(ben).getByTestId("post-bounty-held")).toContainText("50", {
    timeout: 60_000,
  });
  await expect(item(ben).getByTestId("post-bounty-words")).toContainText(
    "A photo of the painted lane on Elm Street, both ends.",
  );
  await expect(status(ben)).toContainText("Takes money and work until");
  // While one is open, people add to it rather than start another.
  await expect(card(ben).getByTestId("post-bounty-open")).toHaveCount(0);

  // ── Cara adds 50 ────────────────────────────────────────────────────────────────────────────────
  const cara = await context.newPage();
  await open(cara, CARA);
  await item(cara).getByTestId("post-bounty-add").click();
  await item(cara).getByTestId("post-bounty-add-amount").fill("50");
  await item(cara).getByTestId("post-bounty-add-submit").click();
  await expect(item(cara).getByTestId("post-bounty-held")).toContainText(
    "100",
    { timeout: 60_000 },
  );
  await expect(item(cara)).toContainText("from 2 people");
  expect(await usdcOf(BOUNTY)).toBe(100n * UNIT);

  // ── Dev submits work ────────────────────────────────────────────────────────────────────────────
  const dev = await context.newPage();
  await open(dev, DEV);
  await item(dev).getByTestId("post-bounty-file").click();
  await item(dev)
    .getByTestId("post-bounty-evidence")
    .fill("https://example.com/elm-street-lane");
  await item(dev).getByTestId("post-bounty-file-submit").click();
  const devClaim = (page: Page) =>
    item(page).getByTestId("post-bounty-claim").first();
  await expect(devClaim(dev)).toContainText(
    "0% of the money that counts backs this",
    { timeout: 60_000 },
  );
  await expect(
    devClaim(dev).getByRole("link", {
      name: "https://example.com/elm-street-lane",
    }),
  ).toBeVisible();
  // Their own work: no backing button, but they can withdraw it.
  await expect(devClaim(dev).getByTestId("post-bounty-back")).toHaveCount(0);
  await expect(
    item(dev).getByTestId("post-bounty-withdraw-claim"),
  ).toBeVisible();

  // ── Ben backs it: exactly half is not a majority ──────────────────────────────────────────────────
  await refresh(ben);
  await devClaim(ben).getByTestId("post-bounty-back").click();
  await expect(devClaim(ben)).toContainText("50% of the money that counts", {
    timeout: 60_000,
  });
  await expect(status(ben)).toContainText("Takes money and work until");

  // ── Cara backs it: a majority, and the wait starts; no new money until it ends ─────────────────
  await refresh(cara);
  await devClaim(cara).getByTestId("post-bounty-back").click();
  await expect(status(cara)).toContainText("Most of the money backs", {
    timeout: 60_000,
  });
  await expect(item(cara).getByTestId("post-bounty-add")).toHaveCount(0);

  // ── A dip stops it: three days in, Cara withdraws, then backs it again ──────────────────────────
  await pass(3 * 86_400);
  await refresh(cara);
  await expect(status(cara)).toContainText("Agreed.");
  await devClaim(cara).getByTestId("post-bounty-unback").click();
  await expect(status(cara)).toContainText("Takes money and work until", {
    timeout: 60_000,
  });
  await devClaim(cara).getByTestId("post-bounty-back").click();
  await expect(status(cara)).toContainText("Most of the money backs", {
    timeout: 60_000,
  });

  // ── Nine days with the majority: anyone pays, here Eve, who put nothing in ──────────────────────
  await pass(9 * 86_400);
  const eve = await context.newPage();
  await open(eve, EVE);
  await expect(status(eve)).toContainText("Anyone can pay it now.", {
    timeout: 30_000,
  });
  if (process.env.E2E_SHOTS) {
    await card(eve).screenshot({
      path: `${process.env.E2E_SHOTS}/post-bounty-payable.png`,
    });
  }
  await item(eve).getByTestId("post-bounty-pay").click();
  await expect(status(eve)).toContainText("Paid 100", { timeout: 60_000 });
  expect(await usdcOf(DEV)).toBe(devBefore + 100n * UNIT);
  expect(await usdcOf(BOUNTY)).toBe(0n);

  // ── A second bounty nobody earns gives Ben his money back ───────────────────────────────────────
  const benBefore = await usdcOf(BEN);
  await refresh(ben);
  await card(ben).getByTestId("post-bounty-open").click();
  await card(ben)
    .getByTestId("post-bounty-words-input")
    .fill("Repaint the crossing at Elm and 3rd.");
  await card(ben).getByTestId("post-bounty-amount").fill("20");
  await card(ben).getByTestId("post-bounty-submit").click();
  const second = card(ben).getByTestId("post-bounty-item").last();
  await expect(second.getByTestId("post-bounty-status")).toContainText(
    "Takes money and work until",
    { timeout: 60_000 },
  );
  expect(await usdcOf(BEN)).toBe(benBefore - 20n * UNIT);
  // The form's default deadline is the end of the day thirty days ahead; with no run on, refunds open right then.
  await pass(31 * 86_400);
  await refresh(ben);
  const lapsed = card(ben).getByTestId("post-bounty-item").last();
  await expect(lapsed.getByTestId("post-bounty-status")).toContainText(
    "No work kept a majority in time.",
    { timeout: 30_000 },
  );
  if (process.env.E2E_SHOTS) {
    await card(ben).screenshot({
      path: `${process.env.E2E_SHOTS}/post-bounty-refunds.png`,
    });
  }
  await lapsed.getByTestId("post-bounty-refund").click();
  await expect(lapsed.getByTestId("post-bounty-refund")).toHaveCount(0, {
    timeout: 60_000,
  });
  expect(await usdcOf(BEN)).toBe(benBefore);
});
