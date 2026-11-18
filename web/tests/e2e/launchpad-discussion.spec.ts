import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { installAnvilWallet } from "../helpers/anvil-wallet";
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Talking about a decision, against a REAL local chain.
 *
 * Opt-in: `scripts/web-discussion-e2e.sh` builds the world (a project launched into its own DAO through the kit, one
 * decision opened) and runs this spec. The decision and the DAO's Shares are read from the chain; the server is a mock
 * that keeps what it is sent. What is checked: a discussion started under the decision is written with the tags that
 * tie it to exactly that decision, it is listed under the decision, and opening it shows the decision's live state from
 * the chain and the author's share of the DAO, with a way back to the vote.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const FACTORY = process.env.E2E_FACTORY ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const BOARD = "5e22a0a0-1111-2222-3333-444444444444";

test.skip(
  !ANVIL_URL || !DAO || !FACTORY,
  "set E2E_ANVIL_URL, E2E_DAO and E2E_FACTORY (scripts/web-discussion-e2e.sh does)",
);

const launchRecord = {
  id: "record-discussion",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-discussion"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A DAO that decides in the open.",
    stage: "graduated",
    currency: CURRENCY || undefined,
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

/** The founder's wallet, bound to their account, so their share of the DAO can be shown. */
const binding = {
  id: "binding-founder",
  pubkey: FOUNDER,
  created_at: 101,
  kind: 37017,
  tags: [
    ["d", FOUNDER_WALLET.toLowerCase()],
    ["address", FOUNDER_WALLET.toLowerCase()],
    ["chain", "31337"],
  ],
  content: "{}",
  sig: "sig",
};

const board = {
  id: "meta-board",
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [["d", BOARD], ["name", "supporters"], ["public"], ["t", "forum"]],
  content: "",
  sig: "sig",
};

async function setUp(page: Page) {
  const relay = createMockRelay({ applyDeletions: true });
  for (const event of [launchRecord, binding, board]) relay.seed(event);
  await relay.install(page);
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  return relay;
}

test("a discussion started under a decision is tied to it, listed there, and shows the decision's live state and the author's Shares when opened", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = await setUp(page);
  await page.goto(`/launchpad/nebula-discussion?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Decisions" }).click();
  const card = page.getByTestId("decision-card");
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("decision-title")).toHaveText(
    "Set aside a work budget",
  );

  // The decision's id, as the chain has it.
  await card.getByRole("button", { name: "Technical details" }).click();
  const decisionId = ((await card.innerText()).match(/0x[0-9a-fA-F]{64}/) ??
    [])[0]?.toLowerCase();
  expect(decisionId).toBeTruthy();

  // Nobody has talked about it yet; the section says what votes on a board are.
  const discussion = page.getByTestId("decision-discussion");
  await expect(page.getByTestId("discussion-empty")).toBeVisible();
  await expect(discussion).toContainText("they are not the project's vote");

  // Start the discussion: the title is started for the author, who adds the details.
  await page.getByTestId("discussion-start").click();
  await expect(page.getByLabel("Title")).toHaveValue(
    "Proposal: Set aside a work budget",
  );
  await page
    .getByLabel("Details (optional)")
    .fill("Is 100 Shares the right size for the first budget?");
  await page.getByTestId("board-composer-submit").click();

  // Written with the tags that tie it to exactly this decision on this chain.
  await expect
    .poll(() => relay.events.find((e) => e.kind === 45001)?.tags)
    .toEqual([
      ["h", BOARD],
      ["t", "proposal"],
      ["t", `proposal:31337:${DAO.toLowerCase()}:${decisionId}`],
    ]);
  await expect(page.getByTestId("discussion-main-thread")).toHaveText(
    "Proposal: Set aside a work budget",
  );

  // Opening it: the community's board, with the decision's live state from the chain...
  await page.getByTestId("discussion-main-thread").click();
  await expect(page).toHaveURL(new RegExp(`channel=${BOARD}&post=`));
  const header = page.getByTestId("proposal-header");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("proposal-status")).toHaveText(
    "Collecting support",
    { timeout: 30_000 },
  );
  await expect(header).toContainText("for Nebula DAO");
  await expect(header).toContainText("They are not the project's vote");
  // ...and the author's share of the DAO beside their name, read from the Shares contract.
  await expect(page.getByTestId("author-badge").first()).toContainText(
    "% of Shares",
    { timeout: 30_000 },
  );

  // And a way back to the vote.
  await page.getByTestId("proposal-open-vote").click();
  await expect(page.getByTestId("decisions-tab")).toBeVisible({
    timeout: 20_000,
  });
});

test("a post that names a DAO the app does not know shows no chain figures and says it could not be checked", async ({
  page,
}) => {
  const relay = await setUp(page);
  const stranger = `0x${"cd".repeat(20)}`;
  relay.seed({
    id: "post-stranger".padEnd(64, "0"),
    pubkey: FOUNDER,
    created_at: Math.floor(Date.now() / 1000) - 60,
    kind: 45001,
    tags: [
      ["h", BOARD],
      ["t", "proposal"],
      ["t", `proposal:31337:${stranger}:0x${"0f".repeat(32)}`],
    ],
    content: "# Claims to be about a DAO\n\nbut it is not one of ours",
    sig: "sig",
  });
  await page.goto(
    `/c/${COMMUNITY_HOST}?channel=${BOARD}&post=${"post-stranger".padEnd(64, "0")}`,
  );
  await expect(page.getByTestId("proposal-unverified")).toContainText(
    "doesn't know that project",
    {
      timeout: 20_000,
    },
  );
  await expect(page.getByTestId("proposal-status")).toHaveCount(0);
  await expect(page.getByTestId("author-badge")).toHaveCount(0);
});

const CHAT = "c4a70000-1111-2222-3333-444444444444";

test("a link to a decision becomes a live card under the message, and a link to an unknown project does not", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = await setUp(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/launchpad/nebula-discussion?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Decisions" }).click();
  const card = page.getByTestId("decision-card");
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await card.getByRole("button", { name: "Technical details" }).click();
  const decisionId =
    ((await card.innerText()).match(/0x[0-9a-fA-F]{64}/) ??
      [])[0]?.toLowerCase() ?? "";

  // "Copy link" gives the address the card is found at.
  await card.getByTestId("decision-copy-link").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const origin = new URL(page.url()).origin;
  expect(copied).toBe(
    `${origin}/launchpad/nebula-discussion?author=${FOUNDER}&tab=decisions&decision=${decisionId}`,
  );

  // Two messages in a chat: one links to the decision, one to a project nobody has heard of.
  relay.seed({
    id: "meta-chat",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", CHAT], ["name", "general"], ["public"], ["t", "stream"]],
    content: "",
    sig: "sig",
  });
  const message = (id: string, text: string, at: number) => ({
    id: id.padEnd(64, "0"),
    pubkey: FOUNDER,
    created_at: Math.floor(Date.now() / 1000) - at,
    kind: 9,
    tags: [["h", CHAT]],
    content: text,
    sig: "sig",
  });
  relay.seed(message("known", `Please look at ${copied} before Friday.`, 20));
  relay.seed(
    message(
      "unknown",
      `Not ours: ${origin}/launchpad/nobody-heard-of-this?decision=${decisionId}`,
      10,
    ),
  );
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${CHAT}`);
  await expect(page.getByText("Please look at")).toBeVisible({
    timeout: 20_000,
  });

  // The known one is a card with the chain's state; the stranger is only a link.
  const embed = page.getByTestId("decision-embed");
  await expect(embed).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("decision-embed-status")).toHaveText(
    "Collecting support",
  );
  await expect(page.getByTestId("decision-embed-title")).toHaveText(
    "Set aside a work budget",
  );
  await expect(embed).toContainText("Nebula DAO");
  await expect(page.getByText("Not ours:")).toBeVisible();

  // The card opens the decision, highlighted.
  await page.getByTestId("decision-embed-open").click();
  await expect(page.getByTestId("decision-card")).toHaveAttribute(
    "data-focused",
    "true",
    {
      timeout: 20_000,
    },
  );
});
