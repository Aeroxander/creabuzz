import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Project Board: a seeded pitch renders, the founder's approval becomes a
 * recorded ownership grant, and the page says so honestly (pool math,
 * provenance labels, the non-binding disclaimer).
 *
 * The fixture is additive — four org-plane events seeded into the in-memory
 * relay, same pattern as the trust-card and org-chart specs. The approve
 * click is the real write path: sign → publish → invalidate → re-derive.
 */

const FOUNDER_NSEC = "11".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(
    FOUNDER_NSEC.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16)),
  ),
);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function nodeEvent() {
  return {
    id: "node-1",
    pubkey: FOUNDER,
    created_at: 1_000,
    kind: 37010,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula"],
      ["seat", FOUNDER],
    ],
    content: JSON.stringify({
      v: 1,
      name: "Nebula",
      kind: "team",
      holders: [FOUNDER],
      agent_seats: [],
    }),
    sig: "sig",
  };
}

function pitchEvent() {
  return {
    id: "pitch-1",
    pubkey: FOUNDER,
    created_at: 1_100,
    kind: 37015,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula"],
      ["role", "founder", "The founder", "40"],
      ["role", "writer", "The writer", "12"],
      ["role", "designer", "The designer", "8"],
    ],
    content: JSON.stringify({
      v: 1,
      summary: "A social app for stargazers.",
      description: "Telescopes, meet timelines.",
      founderRole: "founder",
    }),
    sig: "sig",
  };
}

function grantEvent() {
  return {
    id: "grant-1",
    pubkey: FOUNDER,
    created_at: 1_200,
    kind: 37011,
    tags: [
      ["d", "nebula/designer"],
      ["grantee", BOB],
      ["org", "8"],
      ["role", "designer"],
      ["p", BOB],
    ],
    content: JSON.stringify({
      v: 1,
      issuer: FOUNDER,
      grantee: BOB,
      via: "nebula",
      verbs: [],
      parentGrant: null,
      expires: null,
      revoked: false,
    }),
    sig: "sig",
  };
}

function requestEvent() {
  return {
    id: "request-1",
    pubkey: ALICE,
    created_at: 1_300,
    kind: 37016,
    tags: [
      ["d", `nebula/writer/${ALICE.slice(0, 16)}`],
      ["role", "writer"],
      ["p", FOUNDER],
    ],
    content: JSON.stringify({
      v: 1,
      project: "nebula",
      owner: FOUNDER,
      role: "writer",
      pct: "12",
      note: "I ship newsletters for developer tools.",
      requester: ALICE,
    }),
    sig: "sig",
  };
}

/** A launch record for `nebula` — the summon preview's cap figures live here. */
function launchEvent() {
  return {
    id: "launch-1",
    pubkey: FOUNDER,
    created_at: 1_400,
    kind: 37001,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula"],
      ["t", "dao-launchpad"],
      ["chain", "11155111"],
    ],
    content: JSON.stringify({
      pitch: "Telescopes, meet timelines.",
      stage: "draft",
      currency: "USDC",
      // 1 USDC/mo against a 6 USDC threshold: budget × 6 == threshold.
      budget: "1000000",
      requiredRaised: "6000000",
    }),
    sig: "sig",
  };
}

function seedBoard(relay: ReturnType<typeof createMockRelay>) {
  relay.seed(nodeEvent());
  relay.seed(pitchEvent());
  relay.seed(grantEvent());
  relay.seed(requestEvent());
}

test("the board cards a pitch and flags the founder's pending request", async ({
  page,
}) => {
  const relay = createMockRelay();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await relay.install(page);
  seedBoard(relay);

  await page.goto("/");
  const entry = page.getByRole("link", { name: "Projects" });
  await expect(entry).toBeVisible();
  await entry.click();

  await expect(page.getByTestId("board-card-title")).toHaveText("Nebula");
  await expect(page.getByTestId("role-chip-open")).toHaveText(
    "The writer · 12%",
  );
  await expect(page.getByTestId("board-needs-you")).toHaveText("1 need you");
});

test("approval records one ownership grant and the map says which is which", async ({
  page,
}) => {
  const relay = createMockRelay();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await relay.install(page);
  seedBoard(relay);

  await page.goto("/projects/nebula?author=" + FOUNDER);

  // What is happening: provenance-labelled team map + pool math.
  const team = page.getByTestId("team-map");
  await expect(team).toBeVisible();
  await expect(page.getByTestId("team-source-grant")).toBeVisible();
  await expect(page.getByTestId("team-source-declared")).toBeVisible();
  await expect(page.getByTestId("pool-strip")).toContainText(
    "8% recorded · 60% declared · 92% of the 100% pool",
  );

  // Does it need me: the founder's pending request with a reason it's safe.
  const requests = page.getByTestId("founder-requests");
  await expect(requests).toContainText("asks 12%");
  await expect(page.getByTestId("request-status-pending")).toBeVisible();

  // The stance is on the page where stakes are read and taken.
  await expect(page.getByTestId("stake-disclaimer")).toContainText(
    "Recorded and revocable until the project's DAO adopts the map — not a legal contract",
  );

  // The launchpad bridge states the cap story.
  const bridge = page.getByTestId("dao-bridge");
  await expect(bridge).toContainText("Form the DAO");
  await expect(bridge).toContainText("1/6 of the graduation threshold");
  await expect(bridge).toContainText("3× that budget");

  // What do I do about it: one click publishes exactly one grant.
  await page.getByRole("button", { name: "Approve 12%" }).click();
  await expect(page.getByTestId("pool-strip")).toContainText("20% recorded", {
    timeout: 10_000,
  });
  await expect(team).toContainText("The writer");
  await expect(page.getByTestId("open-role-writer")).toHaveCount(0);

  // The write went through the real path: one kind:37011 on the relay.
  const grants = relay.events.filter((event) => event.kind === 37011);
  expect(grants).toHaveLength(2);
  const approval = grants.find((event) => event.id !== "grant-1");
  expect(approval?.tags).toContainEqual(["d", "nebula/writer"]);
  expect(approval?.tags).toContainEqual(["org", "12"]);
  expect(approval?.tags).toContainEqual(["role", "writer"]);
});

test("a visitor can ask to join a role and the request lands", async ({
  page,
}) => {
  const relay = createMockRelay();
  const visitorNsec = "22".repeat(32);
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [visitorNsec],
  );
  await relay.install(page);
  seedBoard(relay);

  await page.goto("/projects/nebula?author=" + FOUNDER);
  await page.getByRole("button", { name: "Request to join" }).click();
  await page.getByLabel("Why you").fill("Newsletter veteran.");
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(page.getByTestId("my-requests")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("my-requests")).toContainText(
    "Waiting on the founder",
  );
  const requests = relay.events.filter((event) => event.kind === 37016);
  expect(
    requests.some((event) =>
      event.tags.some(
        (tag) => tag[0] === "d" && tag[1]?.startsWith("nebula/writer/"),
      ),
    ),
  ).toBe(true);
});

test("an over-pool pitch is refused before anything reaches the relay", async ({
  page,
}) => {
  const relay = createMockRelay();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await relay.install(page);

  await page.goto("/projects");
  await page.getByRole("button", { name: "Pitch a project" }).click();
  await page.getByLabel("Project name").fill("Neptune");
  await page.getByLabel("One-line pitch").fill("A telescope network.");
  // 90% to the founder + the default 12% writer role breaks the pool bound.
  await page.locator("#role-pct-0").fill("90");

  await page.getByRole("button", { name: "Publish pitch" }).click();

  await expect(page.getByTestId("pitch-roles-error")).toContainText(
    "102% — a project can declare at most 100%",
  );
  expect(
    relay.events.filter(
      (event) => event.kind === 37010 || event.kind === 37015,
    ),
  ).toHaveLength(0);
});

test("the summon preview maps the board to shares and refuses what it must", async ({
  page,
}) => {
  const relay = createMockRelay();
  const founderAddress = "0x" + "11".repeat(20);
  // The viewer's own SIWE binding — the one binding source this build reads
  // (`identity/lib/siwe.ts` `readWalletBinding`); the relay has no read path
  // for anyone else's, so the other seats must come back unbound.
  await page.addInitScript(
    ([nsec, address, pubkey]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem(
        "buzz.siwe.binding",
        JSON.stringify({ address, pubkey, boundAt: 1_000 }),
      );
    },
    [FOUNDER_NSEC, founderAddress, FOUNDER],
  );
  await relay.install(page);
  seedBoard(relay);
  relay.seed(launchEvent());

  await page.goto("/projects/nebula?author=" + FOUNDER);
  await expect(page.getByTestId("dao-bridge")).toContainText(
    "A launch record already exists",
  );
  await page.getByTestId("form-dao").click();

  const dialog = page.getByRole("dialog", { name: "Form the DAO" });
  await expect(dialog).toBeVisible();

  // The cap line names both sides of the 1/6 rule: a year at the cap
  // (1 USDC/mo × 6) against the graduation threshold — within at exactly 6×.
  await expect(page.getByTestId("summon-cap-line")).toHaveText(
    /Budget cap: 6 USDC of 6 USDC — within/,
  );
  await expect(
    page.getByText("Large spends default-pass up to 3 USDC"),
  ).toBeVisible();

  // The founder's seat resolves to a bound address, at pct × 10^18 shares.
  const founderRow = page.getByTestId("summon-seat-founder");
  // truncatePubkey: first 8 chars ("0x111111") … last 4.
  await expect(founderRow).toContainText("0x111111…1111");
  await expect(founderRow).toContainText("40%");
  await expect(founderRow).toContainText("40000000000000000000");

  // The granted seat has no binding: refused loudly, with the fix named.
  await expect(page.getByTestId("summon-seat-designer")).toContainText("—");
  await expect(page.getByTestId("summon-seat-designer")).toContainText(
    "8000000000000000000",
  );
  const unbound = page.getByTestId("summon-unbound");
  await expect(unbound).toContainText("The designer");
  await expect(unbound).toContainText("Ask them to bind an address");

  const blockers = page.getByTestId("summon-blockers");
  await expect(blockers).toContainText("no bound EVM address");
  await expect(blockers).toContainText("No Summoner contract address");

  // The §9 stance stays where the map is read and taken.
  await expect(page.getByTestId("summon-disclaimer")).toContainText(
    "not a legal contract",
  );

  // One action, and it is not armed while a seat cannot be minted.
  await expect(page.getByTestId("summon-run")).toBeDisabled();
  await expect(page.getByTestId("summon-step-send")).toHaveText("pending");
  await expect(page.getByTestId("summon-disabled-reason")).toBeVisible();
});
