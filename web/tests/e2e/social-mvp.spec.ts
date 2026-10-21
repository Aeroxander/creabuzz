import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The social MVP's last gaps (D83): board replies and up votes in notifications, the server's terms and privacy note
 * at sign-up, board posts in search, and a new account's rate limit said plainly.
 */

const FILM = "f1a40000-1111-2222-3333-444444444444";
const ME_NSEC = "55".repeat(32);
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const ME = getPublicKey(key(ME_NSEC));
const ANN = "a1".repeat(32);
const BOB = "b2".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "d");

function board() {
  return {
    id: `meta-${FILM}`,
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", FILM], ["name", "film-making"], ["public"], ["t", "forum"]],
    content: "",
    sig: "sig",
  };
}

function rec(
  pubkey: string,
  kind: number,
  tags: string[][],
  content: string,
  ago = 60,
) {
  return {
    id: eid(),
    pubkey,
    created_at: now() - ago,
    kind,
    tags,
    content,
    sig: "sig",
  };
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  path: string,
  signedIn = true,
) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  if (signedIn) {
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
    }, ME_NSEC);
  }
  await page.goto(path);
}

test("a reply to your board post and up votes on it show in notifications, and open the board", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(board());
  const mine = rec(ME, 45001, [["h", FILM]], "# My trailer\n\nWatch it", 3600);
  relay.seed(mine);
  relay.seed(
    rec(
      ANN,
      45003,
      [
        ["h", FILM],
        ["e", mine.id, "", "reply"],
      ],
      "Great cut!",
    ),
  );
  relay.seed(
    rec(
      ANN,
      45002,
      [
        ["h", FILM],
        ["e", mine.id],
      ],
      "+",
    ),
  );
  relay.seed(
    rec(
      BOB,
      45002,
      [
        ["h", FILM],
        ["e", mine.id],
      ],
      "+",
    ),
  );
  relay.seed(
    rec(
      BOB,
      45002,
      [
        ["h", FILM],
        ["e", "someone-elses-post".padEnd(64, "0")],
      ],
      "+",
    ),
  );
  await open(page, relay, "/social/notifications");

  const reply = page.locator(
    "[data-testid='social-notification'][data-kind='board-reply']",
  );
  await expect(reply).toContainText("replied on a board");
  await expect(reply).toContainText("Great cut!");
  const upvotes = page.locator(
    "[data-testid='social-notification'][data-kind='board-upvote']",
  );
  await expect(upvotes).toHaveCount(1);
  await expect(upvotes).toContainText("and 1 other upvoted your board post");
  await expect(upvotes).toContainText("My trailer");

  await reply.getByRole("link", { name: /Open: replied on a board/ }).click();
  await expect(page).toHaveURL(new RegExp(`/b/${FILM}\\?post=${mine.id}`));
});

test("sign-up asks to agree to the server's terms, and to confirm age when the server asks", async ({
  page,
}) => {
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: {
          terms_markdown: "# Terms",
          privacy_markdown: "# Privacy",
          age_attestation_required: true,
          version: "v1",
        },
      }),
    }),
  );
  const relay = createMockRelay();
  await open(page, relay, "/", false);
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Mira");
  const create = page.getByTestId("onboarding-create");
  await expect(page.getByTestId("onboarding-policy")).toBeVisible();
  await expect(create).toBeDisabled();
  await expect(page.getByTestId("onboarding-passkey")).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "Terms of use" }),
  ).toHaveAttribute("href", /\/api\/join-policy\/terms$/);
  await page.getByTestId("onboarding-policy-agree").check();
  await expect(create).toBeDisabled();
  await page.getByTestId("onboarding-policy-age").check();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
  const accepted = await page.evaluate(() =>
    window.localStorage.getItem("creaton.joinPolicy.accepted"),
  );
  expect(JSON.parse(accepted ?? "{}").version).toBe("v1");
});

test("search finds board posts as well as short posts", async ({ page }) => {
  const relay = createMockRelay();
  relay.seed(board());
  relay.seed(
    rec(ANN, 45001, [["h", FILM]], "# Color grading tips\n\nUse a LUT", 120),
  );
  relay.seed(rec(BOB, 1, [], "My favourite color grading LUT", 60));
  relay.seed(rec(BOB, 1, [], "Unrelated", 30));
  await open(page, relay, "/social/search?q=grading");
  await expect(page.getByTestId("social-board-post-title")).toHaveText(
    "Color grading tips",
  );
  await expect(page.getByTestId("social-post")).toHaveCount(1);
  await expect(page.getByTestId("social-post")).toContainText(
    "My favourite color grading LUT",
  );
});

test("a new account's rate limit is said as a sentence, and the draft is kept", async ({
  page,
}) => {
  const relay = createMockRelay({
    refuse: (event) =>
      event.kind === 1
        ? "rate-limited: new accounts can post 20 times an hour for their first day; try again later"
        : null,
  });
  await open(page, relay, "/");
  await page.getByTestId("social-composer-input").fill("Hello everyone");
  await page.getByTestId("social-composer-submit").click();
  await expect(
    page.getByText(
      "New accounts can post 20 times an hour for their first day; try again later.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("social-composer-input")).toHaveValue(
    "Hello everyone",
  );
});
