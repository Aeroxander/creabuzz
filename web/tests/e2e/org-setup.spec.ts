import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Starting an organization from the Org page, as the community's owner: name it, seat a helper, set what helpers may do
 * alone, and the chart appears. The mock relay stores what the page publishes, so the last assertions read the real
 * records back instead of trusting the screen.
 */

const NSEC = "33".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const HELPER = "d".repeat(64);
const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

const channel = {
  id: "chan-1",
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", CHANNEL_ID],
    ["name", "general"],
  ],
  content: "",
  sig: "sig",
};

const helperAnnouncement = {
  id: "agent-1",
  pubkey: HELPER,
  created_at: Math.floor(Date.now() / 1000),
  kind: 44010,
  tags: [["d", "scout"]],
  content: JSON.stringify({
    name: "Scout",
    runtype: "sandbox",
    status: "available",
    tools: [],
    heartbeat: Math.floor(Date.now() / 1000),
  }),
  sig: "sig",
};

async function open(
  page: import("@playwright/test").Page,
  relay: ReturnType<typeof createMockRelay>,
) {
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("org-toggle").click();
}

test("a community with no organization is offered the setup, and finishing it draws the chart", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(channel);
  relay.seed(helperAnnouncement);
  await open(page, relay);

  const setup = page.getByTestId("org-setup");
  await expect(setup).toBeVisible({ timeout: 20_000 });

  // The first step does not scold an empty form, and will not move on without a name.
  await expect(page.getByTestId("org-setup-issue")).toHaveCount(0);
  await expect(page.getByTestId("org-setup-next")).toBeDisabled();
  await page.getByTestId("org-setup-name").fill("!");
  await expect(page.getByTestId("org-setup-issue")).toContainText("Give your");
  await page.getByTestId("org-setup-name").fill("Nebula Labs");
  await page.getByTestId("org-setup-purpose").fill("Maps the night sky");
  await page.getByTestId("org-setup-next").click();

  // A helper needs a role.
  await page.getByTestId("org-setup-helper-scout").check();
  await expect(page.getByTestId("org-setup-next")).toBeDisabled();
  await page.getByTestId("org-setup-role").fill("Researcher");
  await page.getByTestId("org-setup-next").click();

  // Balanced is the starting choice; a more careful one replaces it.
  await expect(page.getByTestId("org-setup-autonomy-balanced")).toBeChecked();
  await page.getByTestId("org-setup-autonomy-careful").check();
  await page.getByTestId("org-setup-next").click();

  // The review says everything in words before anything is created.
  const review = page.getByTestId("org-setup-review");
  await expect(review).toContainText("A team called “Nebula Labs”");
  await expect(review).toContainText("Scout joins as “Researcher”");
  await expect(review).toContainText(
    "Each helper can run 10 times, start 5 tasks and send 50 messages a day",
  );
  await page.getByTestId("org-setup-create").click();

  // The chart replaces the setup, with the helper under the team.
  await expect(setup).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("Nebula Labs", { exact: true })).toBeVisible();
  await expect(page.getByText("Researcher", { exact: true })).toBeVisible();

  // What was published is what the review promised.
  const stored = relay.events;
  const nodes = stored.filter((e) => e.kind === 37010);
  const budgets = stored.filter((e) => e.kind === 37012);
  expect(
    nodes.map((e) => e.tags.find((t) => t[0] === "d")?.[1]).sort(),
  ).toEqual(["nebula-labs", "nebula-labs-researcher"]);
  expect(nodes.every((e) => e.pubkey === ME)).toBe(true);
  expect(budgets).toHaveLength(1);
  expect(JSON.parse(budgets[0].content)).toMatchObject({
    subject: "*",
    window: "day",
    limits: { runs: 10, tasks: { create: 5 }, messages: 50 },
    onExceed: "require-approval",
  });
});

test("when the server refuses, the person is told what to do and can try again", async ({
  page,
}) => {
  let refuse = true;
  const relay = createMockRelay({
    refuse: (event) =>
      refuse && event.kind === 37010
        ? "restricted: only the community owner may publish an org root"
        : null,
  });
  relay.seed(channel);
  await open(page, relay);

  await expect(page.getByTestId("org-setup")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("org-setup-name").fill("Nebula Labs");
  await page.getByTestId("org-setup-next").click();
  await expect(page.getByTestId("org-setup-helper-none")).toBeChecked();
  await expect(page.getByTestId("org-setup-no-helpers")).toBeVisible();
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-create").click();

  await expect(page.getByTestId("org-setup-problem")).toContainText(
    "Only this community's owner or an admin can start its organization",
  );
  expect(relay.events.filter((e) => e.kind === 37010)).toHaveLength(0);

  // Once the server agrees, the same button finishes the job.
  refuse = false;
  await expect(page.getByTestId("org-setup-create")).toHaveText("Try again");
  await page.getByTestId("org-setup-create").click();
  await expect(page.getByTestId("org-setup")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(relay.events.filter((e) => e.kind === 37010)).toHaveLength(1);
});

test("when only the last record is refused, the first stays, the answers lock, and retrying sends only what is left", async ({
  page,
}) => {
  let refuseLimit = true;
  const relay = createMockRelay({
    refuse: (event) =>
      refuseLimit && event.kind === 37012
        ? "restricted: only the owner may set the community default"
        : null,
  });
  relay.seed(channel);
  await open(page, relay);

  await expect(page.getByTestId("org-setup")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("org-setup-name").fill("Nebula Labs");
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-create").click();

  // The team is out and the chart shows it, but the setup stays up with what went wrong.
  await expect(page.getByTestId("org-setup-problem")).toContainText(
    "Whatever already went through is kept",
  );
  await expect(page.getByTestId("org-setup")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 37010)).toHaveLength(1);
  expect(relay.events.filter((e) => e.kind === 37012)).toHaveLength(0);
  // Changing the name now would leave the first team behind, so the way back is gone.
  await expect(page.getByTestId("org-setup-back")).toHaveCount(0);

  refuseLimit = false;
  await page.getByTestId("org-setup-create").click();
  await expect(page.getByTestId("org-setup")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(relay.events.filter((e) => e.kind === 37010)).toHaveLength(1);
  expect(relay.events.filter((e) => e.kind === 37012)).toHaveLength(1);
});
