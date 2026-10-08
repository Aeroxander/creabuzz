import { expect, test, type Page } from "@playwright/test";
import type { RelayEvent } from "../../src/shared/api/types";
import { installMockBridge } from "../helpers/bridge";

// Mock-mode identity (`DEFAULT_MOCK_PUBKEY` in helpers/bridge.ts) — the
// launch record's author and the mirrored bid's author.
const MOCK_PUBKEY = "deadbeef".repeat(8);

/**
 * Read-only launchpad seed: one kind-37001 record and one kind-47002 bid
 * mirror. The bidder money plane is web-owned, so desktop only ever READS
 * these — the specs below assert the handoff, never a send path.
 */
function launchpadEvents(): RelayEvent[] {
  return [
    {
      id: "a".repeat(64),
      pubkey: MOCK_PUBKEY,
      kind: 37001,
      created_at: 1_700_000_000,
      content: JSON.stringify({
        stage: "live",
        pitch: "A constellation of agents, funded in public.",
      }),
      tags: [
        ["d", "nebula"],
        ["name", "Nebula DAO"],
      ],
      sig: "0".repeat(128),
    },
    {
      id: "b".repeat(64),
      pubkey: MOCK_PUBKEY,
      kind: 47002,
      created_at: 1_700_000_100,
      content: JSON.stringify({
        budget: "1000",
        maxPrice: "5",
        tx: `0x${"ab".repeat(32)}`,
      }),
      tags: [
        ["a", `37001:${MOCK_PUBKEY}:nebula`],
        ["m", "bucket-0"],
      ],
      sig: "0".repeat(128),
    },
  ];
}

/** The URL the last `plugin:opener|open_url` call received, or null. */
async function lastOpenedUrl(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const command = (
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{
            command: string;
            payload: { url?: string };
          }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? []
    )
      .filter(({ command }) => command === "plugin:opener|open_url")
      .pop();
    return command?.payload.url ?? null;
  });
}

async function expectWebHandoff(
  page: Page,
  expected: { action: string },
): Promise<void> {
  // Poll on the LAST opened URL's action: a click always produces a new
  // `open_url` entry, so the expected action appearing is the completion
  // signal — and a missing handoff times out here instead of passing on a
  // previous deep link.
  await expect
    .poll(async () => {
      const raw = await lastOpenedUrl(page);
      return raw === null ? null : new URL(raw).searchParams.get("action");
    })
    .toBe(expected.action);
  const url = new URL((await lastOpenedUrl(page)) ?? "");
  expect(url.pathname).toBe("/launchpad/nebula");
  expect(url.searchParams.get("author")).toBe(MOCK_PUBKEY);
  expect(url.searchParams.get("action")).toBe(expected.action);
}

test.describe("launchpad directory", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    // SPA server has no fallback: enter at root, navigate client-side.
    await page.getByTestId("open-launchpad-view").click();
    await expect(page).toHaveURL(/\/launchpad$/);
  });

  test("renders with empty state and honest money-plane copy", async ({
    page,
  }) => {
    await expect(
      page.getByRole("heading", { name: "Launchpad" }),
    ).toBeVisible();
    await expect(page.getByTestId("launchpad-curate")).toBeVisible();
    await expect(page.getByText("No launches yet.")).toBeVisible();
    await expect(
      page.getByText(
        "Bidding happens on the web app — same account, sponsored.",
      ),
    ).toBeVisible();
  });

  test("new launch dialog validates before publishing", async ({ page }) => {
    await page.getByTestId("launchpad-curate").click();
    const dialog = page.getByRole("dialog", { name: "New launch" });
    await expect(dialog).toBeVisible();
    const publish = dialog.getByRole("button", { name: "Publish launch" });
    await expect(publish).toBeDisabled();

    await dialog.getByLabel("Launch id").fill("Bad Slug!");
    await dialog.getByLabel("Name", { exact: true }).fill("Nebula DAO");
    await expect(publish).toBeDisabled();

    await dialog.getByLabel("Launch id").fill("nebula");
    await expect(publish).toBeDisabled();
    await dialog.getByLabel("Token name", { exact: true }).fill("Nebula Token");
    await dialog.getByLabel("Symbol").fill("NEB");
    await expect(publish).toBeEnabled();
  });
});

test.describe("bidder money plane hands off to the web app", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page, { launchpadEvents: launchpadEvents() });
    await page.goto("/");
    await page.getByTestId("open-launchpad-view").click();
    await expect(page).toHaveURL(/\/launchpad$/);
    await page.getByTestId("launchpad-launch-card").click();
    await expect(page).toHaveURL(/\/launchpad\/nebula/);
  });

  test("the bid affordance is launch status plus a web deep link", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Back this launch" }).click();
    const dialog = page.getByTestId("bid-on-web-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(
        "Bidding happens on the web app — same account, sponsored.",
      ),
    ).toBeVisible();
    await expect(dialog.getByText(/Auction not deployed yet/)).toBeVisible();

    // No send path on desktop: the money action is the deep link.
    await dialog.getByTestId("continue-on-web-bid").click();
    await expectWebHandoff(page, { action: "bid" });
  });

  test("my bids is read-only status with exit/claim deep links", async ({
    page,
  }) => {
    await page.getByRole("tab", { name: "My bids" }).click();
    await expect(
      page.getByText(/Read-only bid status for this launch/),
    ).toBeVisible();
    await expect(page.getByText("Bid · bucket-0")).toBeVisible();

    // The old in-app send buttons are gone for good.
    await expect(
      page.getByRole("button", { name: "Claim", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Claim all (1)" }),
    ).toHaveCount(0);

    await page.getByTestId("continue-on-web-exit").click();
    await expectWebHandoff(page, { action: "exit" });
    await page.getByTestId("continue-on-web-claim").click();
    await expectWebHandoff(page, { action: "claim" });
  });
});

test("queued governance keeps delegated reallocation and withdrawal reachable", async ({
  page,
}) => {
  const dao = "0x1111111111111111111111111111111111111111";
  const source = "0x2222222222222222222222222222222222222222";
  const seeded = launchpadEvents();
  seeded.push({
    ...seeded[0],
    id: "c".repeat(64),
    kind: 47004,
    tags: [["a", `37001:${MOCK_PUBKEY}:nebula`]],
    content: JSON.stringify({
      proposalId: "1",
      title: "Fund the team",
      state: "open",
      kind: "plain",
      onchain: { chain: "31337", dao },
    }),
  });
  await installMockBridge(page, { launchpadEvents: seeded });
  await page.goto("/");
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          payload?: { data?: string },
        ) => Promise<unknown>;
      };
      allocationSends?: string[];
    };
    const original = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    let amount = 0n;
    const unit = 10n ** 18n;
    const word = (v: bigint | number) =>
      BigInt(v).toString(16).padStart(64, "0");
    w.allocationSends = [];
    w.__TAURI_INTERNALS__.invoke = async (command, payload) => {
      if (command === "evm_call") {
        const data = payload?.data ?? "";
        let words: (number | bigint)[] = [0];
        if (data.startsWith("0x3e4f49e6")) words = [2];
        if (data.startsWith("0x54b31217"))
          words = [
            100n * unit - amount,
            100n * unit,
            100n * unit,
            amount,
            1,
            100n * unit,
          ];
        if (data.startsWith("0x4bcaf6aa")) words = [amount, 0, 0, 0];
        if (data.startsWith("0xb1f792c9")) {
          const now = Math.floor(Date.now() / 1000);
          words = [
            100n * unit,
            20n * unit,
            0,
            6600,
            now - 48 * 3600,
            now + 14 * 86400,
            86400,
            12 * 3600,
            0,
            1,
          ];
        }
        return { returnData: `0x${words.map(word).join("")}` };
      }
      if (command === "evm_send_transaction") {
        const data = payload?.data ?? "";
        w.allocationSends?.push(data);
        amount = BigInt(`0x${data.slice(-64)}`);
      }
      return original(command, payload);
    };
  });
  await page.getByTestId("open-launchpad-view").click();
  await page.getByTestId("launchpad-launch-card").click();
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("voting-allocation-controls")).toBeVisible();
  await page.getByLabel("Vote on behalf of (optional)").fill(source);
  await page.getByLabel("Shares to allocate").fill("70");
  await page.getByTestId("proposal-vote-for").click();
  await expect(page.getByTestId("voting-allocation-balance")).toContainText(
    "70 allocated here",
  );
  await page.getByLabel("Shares to allocate").fill("invalid amount");
  await page.getByTestId("proposal-vote-withdraw").click();
  await expect(page.getByTestId("voting-allocation-balance")).toContainText(
    "100 free",
  );
  const sends = await page.evaluate(
    () => (window as unknown as { allocationSends: string[] }).allocationSends,
  );
  const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0");
  expect(sends).toEqual(
    [70n * 10n ** 18n, 0n].map(
      (amount) =>
        `0x87906434${source.slice(2).padStart(64, "0")}${word(1)}${word(1)}${word(amount)}`,
    ),
  );
});
