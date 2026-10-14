import { createHash } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * "Who holds the IP" on a launch page: what the app says for each thing a
 * project can have on record, who may change it, and that changing it keeps
 * every other part of the launch record.
 *
 * The weaker standings must never say holders own anything; that line is
 * checked on every one.
 */

const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const FOUNDER_NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(key(FOUNDER_NSEC));
const VISITOR_NSEC = "33".repeat(32);
const DISTRIBUTOR = `0x${"4".repeat(40)}`;
const SHA = "ab".repeat(32);

const doc = (title: string) => ({
  title,
  url: "https://example.com/agreement.pdf",
  sha256: SHA,
});
const entity = { name: "Nebula Series LLC", jurisdiction: "Marshall Islands" };

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
      ["distributor", DISTRIBUTOR],
    ],
    content: JSON.stringify({
      pitch: "To the stars.",
      stage: "live",
      currency: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      floorPrice: "792281625140000",
      tickSpacing: "79228162514",
      requiredRaised: "299999999998",
      budget: "50000000000",
      legalWrapper: "dao-llc",
      tokenPlan: {
        mode: "mint",
        name: "Nebula Token",
        symbol: "NBL",
        supply: "200000000",
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

const standing = (page: Page) =>
  page.getByTestId("ip-standing").getAttribute("data-standing");

test("a project that has said nothing is told so, and a visitor cannot edit", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(launchRecord());
  await open(page, relay, VISITOR_NSEC);

  expect(await standing(page)).toBe("unstated");
  await expect(page.getByTestId("ip-headline")).toContainText(
    "hasn't said who holds its IP",
  );
  await expect(page.getByTestId("ip-card")).not.toContainText(/holders own/i);
  await expect(page.getByTestId("ip-edit")).toHaveCount(0);
});

test("each standing says only what the documents on record support", async ({
  page,
}) => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    [
      "open",
      { ipRecord: { v: 1, holder: "open", licence: "MIT" } },
      "open",
      "Open: released under MIT",
    ],
    [
      "founders-uncommitted",
      { ipRecord: { v: 1, holder: "founders" } },
      "founders-uncommitted",
      "The founders hold the IP themselves",
    ],
    [
      "founders-committed",
      { ipRecord: { v: 1, holder: "founders", assignment: doc("Commitment") } },
      "founders-committed",
      "committed to assign it",
    ],
    [
      "entity-unassigned",
      { ipRecord: { v: 1, holder: "entity", entity } },
      "entity-unassigned",
      "no assignment is on record",
    ],
    [
      "entity-on-raise",
      {
        ipRecord: {
          v: 1,
          holder: "entity",
          entity,
          assignment: doc("Assignment"),
        },
      },
      "entity-on-raise",
      "when the raise completes",
    ],
  ];
  for (const [name, content, want, words] of cases) {
    const relay = createMockRelay();
    relay.seed(launchRecord(content));
    await open(page, relay, VISITOR_NSEC);
    expect(await standing(page), name).toBe(want);
    await expect(page.getByTestId("ip-headline"), name).toContainText(words);
    // The weaker standings never say holders own anything.
    await expect(page.getByTestId("ip-card"), name).not.toContainText(
      /holders own|you own/i,
    );
    await page.unroute("**/*").catch(() => undefined);
  }
});

test("an assigned project says holders direct the entity only when the operating agreement is on record", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(
    launchRecord({
      stage: "graduated",
      ipRecord: {
        v: 1,
        holder: "entity",
        entity,
        assignment: doc("Assignment"),
        operating: doc("Operating agreement"),
      },
    }),
  );
  await open(page, relay, VISITOR_NSEC);
  expect(await standing(page)).toBe("entity-assigned");
  await expect(page.getByTestId("ip-headline")).toContainText(
    "The IP is assigned to Nebula Series LLC",
  );
  await expect(page.getByTestId("ip-card")).toContainText(
    "has it act on holders' decisions",
  );
  // The documents are links with their fingerprints, and it says whose statement this is.
  await expect(page.getByTestId("ip-documents")).toContainText(
    "Operating agreement",
  );
  await expect(page.getByTestId("ip-documents")).toContainText(
    "Fingerprint abababab",
  );
  await expect(page.getByTestId("ip-card")).toContainText(
    "This is the project's own statement",
  );
});

test("the founder records the commitment, and saving keeps the rest of the launch", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(launchRecord());
  await open(page, relay, FOUNDER_NSEC);

  await page.getByTestId("ip-edit").click();
  // A project with no entity yet is where it starts.
  await expect(page.getByTestId("ip-holder-founders")).toBeChecked();
  await page
    .getByTestId("ip-doc-assignment-title")
    .fill("Commitment to assign");
  await page
    .getByTestId("ip-doc-assignment-url")
    .fill("https://example.com/commitment.pdf");
  await page.getByTestId("ip-doc-assignment-hash").fill(SHA);
  await page.getByTestId("ip-save").click();

  await expect
    .poll(() => relay.events.filter((e) => e.kind === 37001).length)
    .toBe(2);
  const saved = relay.events
    .filter((e) => e.kind === 37001)
    .find((e) => JSON.parse(e.content).ipRecord);
  const body = JSON.parse(saved?.content ?? "{}");
  expect(body.ipRecord).toEqual({
    v: 1,
    holder: "founders",
    assignment: {
      title: "Commitment to assign",
      url: "https://example.com/commitment.pdf",
      sha256: SHA,
    },
  });
  // Everything else the record held is still there: the legal wrapper and the
  // deploy tag were erased by a save before.
  expect(body).toMatchObject({
    pitch: "To the stars.",
    stage: "live",
    legalWrapper: "dao-llc",
    tokenPlan: { symbol: "NBL" },
    budget: "50000000000",
  });
  expect(saved?.tags).toContainEqual(["distributor", DISTRIBUTOR]);
  expect(saved?.tags).toContainEqual(["d", "nebula"]);

  await expect(page.getByTestId("ip-editor")).toHaveCount(0);
  await expect.poll(() => standing(page)).toBe("founders-committed");
});

test("choosing the file fingerprints it in the browser", async ({ page }) => {
  const relay = createMockRelay();
  relay.seed(launchRecord());
  await open(page, relay, FOUNDER_NSEC);
  await page.getByTestId("ip-edit").click();
  await page.getByTestId("ip-holder-entity").check();
  await page.getByTestId("ip-entity-name").fill("Nebula Series LLC");
  await page.getByTestId("ip-entity-place").fill("Marshall Islands");

  const bytes = Buffer.from("A signed assignment, as a file.");
  await page.getByTestId("ip-doc-assignment-file").setInputFiles({
    name: "assignment.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  const expected = createHash("sha256").update(bytes).digest("hex");
  await expect(page.getByTestId("ip-doc-assignment-hash")).toHaveValue(
    expected,
  );
  // The title is taken from the file name unless one is typed.
  await expect(page.getByTestId("ip-doc-assignment-title")).toHaveValue(
    "assignment",
  );
});

test("a half-filled document is refused and nothing is published", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(launchRecord());
  await open(page, relay, FOUNDER_NSEC);
  await page.getByTestId("ip-edit").click();
  await page.getByTestId("ip-doc-assignment-title").fill("Commitment");
  await page.getByTestId("ip-save").click();
  await expect(page.getByTestId("ip-problem")).toContainText(
    "needs a title, an https link and a fingerprint",
  );
  expect(relay.events.filter((e) => e.kind === 37001)).toHaveLength(1);

  // An http link is refused too: the record only points at https documents.
  await page
    .getByTestId("ip-doc-assignment-url")
    .fill("http://example.com/a.pdf");
  await page.getByTestId("ip-doc-assignment-hash").fill(SHA);
  await page.getByTestId("ip-save").click();
  await expect(page.getByTestId("ip-problem")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 37001)).toHaveLength(1);
});
