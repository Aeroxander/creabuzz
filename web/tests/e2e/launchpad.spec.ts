import { expect, test } from "@playwright/test";

const FOUNDER = "a".repeat(64);

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
    content: JSON.stringify({ pitch: "To the stars.", stage: "live" }),
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

async function mockRelay(page: import("@playwright/test").Page) {
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[0] !== "REQ") return;
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
