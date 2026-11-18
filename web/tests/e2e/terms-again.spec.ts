import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Changed terms at the next visit: a signed-in person who agreed to an older version is asked to agree again before
 * they can post. "Not now" leaves them signed in and unable to post, with a way to read the text and to sign out;
 * agreeing lets them carry on.
 */

const BOARD = "b0a4d000-1111-2222-3333-444444444444";
const OWNER_NSEC = "55".repeat(32);
const OWNER = getPublicKey(
  Uint8Array.from(OWNER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);
const ACCEPTED_KEY = "creaton.joinPolicy.accepted";

function policyBody(version: string) {
  return {
    policy: {
      terms_markdown: "# Terms",
      privacy_markdown: "# Privacy",
      age_attestation_required: false,
      version,
    },
  };
}

/** Open the board as a signed-in person who agreed to `agreed`, with the server now serving `served`. */
async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  agreed: string,
  served: () => unknown,
) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({ status: 200, json: served() }),
  );
  await relay.install(page);
  await page.addInitScript(
    ({ nsec, key, version }) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      if (!window.sessionStorage.getItem("seeded")) {
        window.sessionStorage.setItem("seeded", "1");
        window.localStorage.setItem(key, JSON.stringify({ version, at: 1 }));
      }
    },
    { nsec: OWNER_NSEC, key: ACCEPTED_KEY, version: agreed },
  );
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${BOARD}`);
  await page.getByTestId("content-pane").waitFor();
}

test("changed terms ask a signed-in person to agree again, block posting until they do, then let them carry on", async ({
  page,
}) => {
  let served = "v1";
  const relay = createMockRelay();
  relay.seed({
    id: `meta-${BOARD}`,
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", BOARD], ["name", "ideas"], ["public"], ["t", "forum"]],
    content: "",
    sig: "sig",
  });
  await open(page, relay, "v1", () => policyBody(served));

  // The version agreed to is the served one: nothing is asked.
  await expect(page.getByTestId("terms-again-dialog")).toHaveCount(0);
  await expect(page.getByTestId("terms-again-notice")).toHaveCount(0);

  // The server's text changes. At the next visit the dialog asks, and agreeing needs the box.
  served = "v2";
  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  const dialog = page.getByTestId("terms-again-dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "The terms have changed" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Terms of use" }),
  ).toHaveAttribute("href", /\/api\/join-policy\/terms$/);
  const agree = page.getByTestId("terms-again-agree");
  await expect(agree).toBeDisabled();

  // "Not now": still signed in, the text can be read again, and posting is refused with words that say what to do.
  await page.getByTestId("terms-again-not-now").click();
  await expect(dialog).toHaveCount(0);
  const notice = page.getByTestId("terms-again-notice");
  await expect(notice).toContainText("cannot post or act yet");
  await expect(
    notice.getByRole("link", { name: "Privacy note" }),
  ).toHaveAttribute("href", /\/api\/join-policy\/privacy$/);
  await expect(page.getByTestId("terms-again-sign-out")).toBeVisible();

  await page.getByTestId("board-new-post").click();
  await page.getByLabel("Title").fill("Ship the trailer first");
  await page.getByTestId("board-composer-submit").click();
  await expect(page.getByTestId("board-composer-problem")).toContainText(
    "have not agreed to them yet",
  );
  expect(relay.events.some((e) => e.kind === 45001)).toBe(false);

  // Review, tick the box and agree: the notice goes, the version is kept, and the same post now goes out.
  await page.getByTestId("terms-again-review").click();
  await expect(dialog).toBeVisible();
  await page.getByTestId("onboarding-policy-agree").check();
  await agree.click();
  await expect(dialog).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  const kept = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    ACCEPTED_KEY,
  );
  expect(JSON.parse(kept ?? "{}").version).toBe("v2");

  await page.getByTestId("board-composer-submit").click();
  await expect(page.getByTestId("board-composer")).toHaveCount(0);
  expect(
    relay.events.find((e) => e.kind === 45001 && e.pubkey === OWNER)?.content,
  ).toBe("# Ship the trailer first");
});

test("a server that does not answer blocks nothing and says the terms could not be checked", async ({
  page,
}) => {
  const relay = createMockRelay();
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({ status: 503, json: { error: "down" } }),
  );
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, OWNER_NSEC);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();
  await expect(
    page.getByText("We could not check whether the terms have changed"),
  ).toBeVisible();
  await expect(page.getByTestId("terms-again-dialog")).toHaveCount(0);
  await expect(page.getByTestId("terms-again-notice")).toHaveCount(0);
});
