import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The team's revenue pledge on a launch page (D78): what a visitor reads, that only the author edits it, that a bad
 * pledge is refused with the reason, and that saving keeps every other part of the launch record. Every sentence about
 * a pledge says the contracts do not enforce it.
 */

const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const FOUNDER_NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(key(FOUNDER_NSEC));
const VISITOR_NSEC = "33".repeat(32);

function launchRecord(over: Record<string, unknown> = {}) {
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
      currency: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      floorPrice: "39614081257000",
      tickSpacing: "79228162514",
      requiredRaised: "299999999998",
      budget: "50000000000",
      legalWrapper: "dao-llc",
      tokenPlan: {
        mode: "dao",
        name: "Nebula",
        symbol: "NEB",
        supply: "600000000",
      },
      ...over,
    }),
    sig: "sig",
  };
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  nsec: string,
) {
  await relay.install(page);
  await page.addInitScript((secret) => {
    window.localStorage.setItem("buzz.identity.nsec", secret);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, nsec);
  await page.goto("/launchpad/nebula");
  await page.getByTestId("ip-card").waitFor();
}

test("a visitor reads the pledge, with the reminder that nothing enforces it, and cannot edit it", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(
    launchRecord({ revenuePledge: { v: 1, percent: 20, every: "quarter" } }),
  );
  await open(page, relay, VISITOR_NSEC);
  await expect(page.getByTestId("pledge-sentence")).toHaveText(
    "The team pledges 20% of the project's net receipts to the treasury, every quarter, for as long as the project earns. It is not written into a signed document on record. The contracts do not enforce it.",
  );
  await expect(page.getByTestId("pledge-edit")).toHaveCount(0);
});

test("a project that pledged nothing shows a visitor nothing", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(launchRecord());
  await open(page, relay, VISITOR_NSEC);
  await expect(page.getByTestId("pledge-card")).toHaveCount(0);
});

test("the founder adds a pledge, a bad one is refused, and saving keeps the rest of the launch", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(launchRecord());
  await open(page, relay, FOUNDER_NSEC);

  await page.getByTestId("pledge-edit").click();
  await page.getByTestId("pledge-percent").fill("12.5");
  await page.getByTestId("pledge-save").click();
  await expect(page.getByTestId("pledge-problem")).toContainText(
    "whole percent",
  );

  await page.getByTestId("pledge-percent").fill("20");
  await page.getByTestId("pledge-every").selectOption("month");
  await page.getByTestId("pledge-until").fill("2030-12-31");
  await page.getByTestId("pledge-save").click();

  await expect
    .poll(() => relay.events.filter((e) => e.kind === 37001).length)
    .toBe(2);
  const saved = relay.events
    .filter((e) => e.kind === 37001)
    .find((e) => JSON.parse(e.content).revenuePledge);
  const body = JSON.parse(saved?.content ?? "{}");
  expect(body.revenuePledge).toEqual({
    v: 1,
    percent: 20,
    every: "month",
    until: "2030-12-31",
  });
  expect(body).toMatchObject({
    pitch: "To the stars.",
    legalWrapper: "dao-llc",
    budget: "50000000000",
    tokenPlan: { symbol: "NEB" },
  });
  await expect(page.getByTestId("pledge-editor")).toHaveCount(0);
  await expect(page.getByTestId("pledge-sentence")).toContainText(
    "every month, until 2030-12-31",
  );
});
