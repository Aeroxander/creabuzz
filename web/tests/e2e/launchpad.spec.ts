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
