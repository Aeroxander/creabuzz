import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

/**
 * The founder is a real identity this time: the Manage tab is founder-only, so a
 * made-up pubkey meant it never rendered. The seed is the fixed test key.
 */
const FOUNDER_NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(FOUNDER_NSEC.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  ),
);

function record() {
  return {
    id: "record-1",
    pubkey: FOUNDER,
    created_at: 100,
    kind: 37001,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula DAO"],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
      ["chain", "11155111"],
    ],
    content: JSON.stringify({
      pitch: "To the stars.",
      stage: "live",
      // A deployable price grid: the form validates these against the auction
      // contract, so a fixture with half of them leaves Save disabled.
      floorPrice: "792281625140000",
      tickSpacing: "79228162514",
      requiredRaised: "299999999998",
      tokenPlan: {
        mode: "mint",
        name: "Nebula Token",
        symbol: "NBL",
        supply: "200000000",
      },
    }),
    sig: "sig",
  };
}

function update() {
  return {
    id: "update-1",
    pubkey: FOUNDER,
    created_at: 200,
    kind: 47003,
    tags: [["a", `37001:${FOUNDER}:nebula`]],
    content: JSON.stringify({ title: "Ship it", body: "We shipped." }),
    sig: "sig",
  };
}

/** Events the page published, so a test can assert what a save wrote. */
const published: Array<{ kind: number; content: string; tags: string[][] }> =
  [];

async function mockRelay(page: import("@playwright/test").Page) {
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
        // Acknowledge writes, as a relay does: without an OK the publish path
        // waits for its timeout, so a save test would prove nothing.
        const event = parsed[1] as {
          id: string;
          content: string;
          tags: string[][];
        };
        published.push({
          kind: Number((event as { kind?: number }).kind ?? 0),
          content: String(event.content ?? ""),
          tags: event.tags ?? [],
        });
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      const kinds: number[] = filter.kinds ?? [];
      if (kinds.includes(37001))
        ws.send(JSON.stringify(["EVENT", subId, record()]));
      if (kinds.includes(47003))
        ws.send(JSON.stringify(["EVENT", subId, update()]));
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockRelay(page);
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await page.goto("/launchpad");
});

test("directory renders launches from the relay", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Launchpad" })).toBeVisible();
  await expect(page.getByText("Nebula DAO")).toBeVisible();
  await expect(page.getByText("To the stars.")).toBeVisible();
});

test("detail shows overview and updates", async ({ page }) => {
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await expect(page.getByText("Raise terms")).toBeVisible();
  await page.getByRole("tab", { name: /Updates/ }).click();
  await expect(page.getByText("We shipped.")).toBeVisible();
});

test("a production build shows no fabricated funding figures", async ({
  page,
}) => {
  // The preview fixture is development-only. This build (and CI) is a
  // production build, so an unlinked or unreachable auction must report "no
  // chain data" rather than a plausible raise percentage.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await expect(page.getByTestId("launch-progress-source")).toHaveText(
    "No chain data",
  );
  await expect(page.getByTestId("launch-progress-unavailable")).toContainText(
    "No auction contract is linked",
  );
  await expect(page.getByText("Preview data")).toBeHidden();
});

test("the create form refuses parameters the auction contract would reject", async ({
  page,
}) => {
  // The constructor's reverts happen after the founder has written the terms, so
  // the form has to catch them. The defaults this app shipped could not be
  // deployed at all: floor 1e6 is below the contract's minimum.
  await page.getByRole("button", { name: "New launch" }).first().click();
  // Name and slug first: the form is invalid without them, which would make the
  // enabled/disabled assertion below prove nothing.
  await page.getByLabel("Launch id").fill("nebula-two");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Two");

  await expect(page.getByTestId("launch-param-issues")).toBeHidden();
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeEnabled();

  // A floor below MIN_FLOOR_PRICE, on top of a spacing that does not divide it.
  await page.getByLabel("Floor price").fill("1000000");
  await page.getByLabel("Tick spacing").fill("100");
  const issues = page.getByTestId("launch-param-issues");
  await expect(issues).toBeVisible();
  await expect(issues).toContainText("floorPrice");
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeDisabled();
});

test("recommended terms fill in deployable numbers", async ({ page }) => {
  await page.getByRole("button", { name: "New launch" }).first().click();
  await page.getByLabel("Launch id").fill("nebula-three");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Three");
  await page.getByLabel("Floor price").fill("1000000");
  await page.getByTestId("launch-recommended-terms").click();

  await expect(page.getByTestId("launch-param-issues")).toBeHidden();
  const floor = await page.getByLabel("Floor price").inputValue();
  const spacing = await page.getByLabel("Tick spacing").inputValue();
  // On the grid and above the contract minimum, without the reader checking by
  // hand: the two numbers the contract is strictest about.
  expect(BigInt(floor)).toBeGreaterThanOrEqual((1n << 32n) + 1n);
  expect(BigInt(floor) % BigInt(spacing)).toBe(0n);
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeEnabled();
});

test("editing the terms keeps the token plan and the price grid", async ({
  page,
}) => {
  // "Edit terms" reset `tickSpacing` to "" and dropped `tokenPlan` on every save,
  // so terms the founder had set disappeared — and because the Mint panel is
  // gated on `tokenPlan`, it could never come back. The mint fields were also
  // never seeded from the record, which left "Save changes" disabled with no
  // explanation the moment the dialog opened.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await page.getByRole("tab", { name: /Manage/ }).click();

  published.length = 0;
  await page.getByRole("button", { name: "Edit terms" }).click();
  // The mint fields are seeded, so the dialog is saveable without retyping them.
  await expect(page.getByLabel("Token name")).toHaveValue("Nebula Token");
  await expect(
    page.getByRole("button", { name: /Save changes/ }),
  ).toBeEnabled();

  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(page.getByText("Launch updated.")).toBeVisible({
    timeout: 15_000,
  });

  const saved = published[published.length - 1];
  expect(saved, "a launch record must have been published").toBeTruthy();
  const content = JSON.parse(saved.content);
  expect(
    content.tokenPlan,
    "the mint handoff must survive an edit",
  ).toBeTruthy();
  expect(
    content.tickSpacing,
    "the price grid must survive an edit",
  ).toBeTruthy();
});

test("the raise terms are money a buyer can read", async ({ page }) => {
  // Every figure used to be raw atomic units: `1000000000 / 1000000000` is not
  // something anyone can act on, and the settle-either-way terms were absent.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);

  await expect(page.getByText("Graduation threshold")).toBeVisible();
  await expect(page.getByText("300,000 USDC")).toBeVisible();
  await expect(page.getByText("None set", { exact: false })).toHaveCount(0);
  await expect(page.getByText("$0.01 per token")).toBeVisible();

  // The two outcomes, before the money moves.
  const settlement = page.getByTestId("launch-settlement-terms");
  await expect(settlement).toContainText("If the threshold is met");
  await expect(settlement).toContainText("If the threshold is missed");
  await expect(settlement).toContainText("refundable in full");
});

test("the founder sees what is still missing before deploying", async ({
  page,
}) => {
  // The gaps that block a deployment were only discoverable by a reverting
  // constructor. The fixture has terms and a token plan but no auction, treasury
  // or channel.
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();

  const readiness = page.getByTestId("launch-readiness");
  await expect(readiness).toBeVisible({ timeout: 15_000 });
  await expect(readiness).toContainText("3 steps still open");
  await expect(readiness).toContainText("Sale parameters");
  await expect(readiness).toContainText("Auction contract");
  await expect(readiness).toContainText(
    "link it, so bids have somewhere to go",
  );

  // The sale parameters are valid, so that line carries no hint.
  const parameters = readiness.locator("li", { hasText: "Sale parameters" });
  await expect(parameters).not.toContainText("Floor price on the tick grid");
});
