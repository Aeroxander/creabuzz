import { expect, test, type Page } from "@playwright/test";
import { waitForAnimations } from "../../../desktop/tests/helpers/animations";
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
    FOUNDER_NSEC.match(/.{2}/g)?.map((b) => Number.parseInt(b, 16)),
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

/** A launch record for `nebula`: once it exists, the project is running. */
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

  // The board is reached from Discover, which is where the whole directory lives.
  await page.goto("/discover");
  const entry = page.getByTestId("discover-board");
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.getByRole("link", { name: "Discover" })).toHaveAttribute(
    "aria-current",
    "page",
  );

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

  await page.goto(`/projects/nebula?author=${FOUNDER}`);

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
    "Recorded and revocable until the project's DAO adopts the map. Not a legal contract",
  );

  // The way on: each role becomes a project its person earns by delivering.
  const bridge = page.getByTestId("dao-bridge");
  await expect(bridge).toContainText("Start it as a contributor project");
  await expect(bridge).toContainText("Each role becomes a work area");
  await expect(page.getByTestId("start-contributor-project")).toBeVisible();

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

  await page.goto(`/projects/nebula?author=${FOUNDER}`);
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
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // 90% to the founder + the default 12% writer role breaks the pool bound.
  await page.locator("#role-pct-0").fill("90");

  await page.getByRole("button", { name: "Publish pitch" }).click();

  await expect(page.getByTestId("pitch-roles-error")).toContainText(
    "102%. A project can declare at most 100%",
  );
  expect(
    relay.events.filter(
      (event) => event.kind === 37010 || event.kind === 37015,
    ),
  ).toHaveLength(0);
});

test("the founder starts the board's team as a contributor project: each role is a first project worth its stake", async ({
  page,
}) => {
  const relay = createMockRelay();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await relay.install(page);
  seedBoard(relay);

  await page.goto(`/projects/nebula?author=${FOUNDER}`);
  await page.getByTestId("start-contributor-project").click();
  await expect(page).toHaveURL(/\/start\/contributor\?/);

  // 1,000,000 Shares are the whole project: the founder's 40% is what they start with, and the writer's 12% and the
  // designer's 8% are projects of 120,000 and 80,000. The budget is three times the founder's start (D79), so it has
  // room for 1,000,000 more for people who join later.
  const from = page.getByTestId("contributor-from-board");
  await expect(from).toContainText(
    "Your declared stake is what you start with",
  );
  await expect(from).toContainText("room for 1,000,000 Shares");
  await expect(page.getByTestId("contributor-name")).toHaveValue("Nebula");
  await expect(page.getByTestId("contributor-pitch")).toHaveValue(
    "A social app for stargazers.",
  );
  await expect(page.getByTestId("contributor-founder-shares")).toHaveValue(
    "400000",
  );
  await expect(page.getByTestId("contributor-budget-shares")).toHaveValue(
    "1200000",
  );
  await expect(page.getByTestId("contributor-project-name")).toHaveValue(
    "The writer",
  );
  await expect(page.getByTestId("contributor-project-shares-0")).toHaveValue(
    "120000",
  );
  await expect(page.getByTestId("contributor-project-check")).toHaveValue(
    "The writer: the work agreed for this role is delivered, and the reviewers accept it.",
  );
  await expect(page.getByTestId("contributor-project-name-1")).toHaveValue(
    "The designer",
  );
  await expect(page.getByTestId("contributor-project-shares-1")).toHaveValue(
    "80000",
  );
  // The designer's role has a person in it: the check names them.
  await expect(page.getByTestId("contributor-project-check-1")).toHaveValue(
    /^The designer: the work agreed for this role is delivered by .+, and the reviewers accept it\.$/,
  );
  // Nothing is sent until the founder presses start.
  expect(relay.events.filter((event) => event.kind === 37001)).toHaveLength(0);
});

test("only the founder can start it, and a started project links to its work", async ({
  browser,
}) => {
  // Someone else following the founder's link is told why it is not filled in.
  const visitor = await browser.newPage();
  const relay = createMockRelay();
  await visitor.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    ["22".repeat(32)],
  );
  await relay.install(visitor);
  seedBoard(relay);
  await visitor.goto(`/projects/nebula?author=${FOUNDER}`);
  await expect(visitor.getByTestId("dao-bridge")).toContainText(
    "The founder starts it",
  );
  await expect(visitor.getByTestId("start-contributor-project")).toHaveCount(0);
  await visitor.goto(`/start/contributor?project=nebula&author=${FOUNDER}`);
  await expect(
    visitor.getByTestId("contributor-from-board-problem"),
  ).toHaveText("Only the person who posted the project can start it.");
  await expect(visitor.getByTestId("contributor-name")).toHaveValue("");
  await visitor.close();

  // Once its launch record exists, the board sends people to its work instead.
  const founder = await browser.newPage();
  const started = createMockRelay();
  await founder.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await started.install(founder);
  seedBoard(started);
  started.seed(launchEvent());
  await founder.goto(`/projects/nebula?author=${FOUNDER}`);
  await expect(founder.getByTestId("dao-bridge")).toContainText(
    "This project is running",
  );
  await expect(founder.getByTestId("dao-bridge-link")).toHaveAttribute(
    "href",
    /\/launchpad\/nebula\?.*tab=work/,
  );
  await expect(founder.getByTestId("start-contributor-project")).toHaveCount(0);
  await founder.close();
});

async function openPitch(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  theme = "light",
) {
  await page.addInitScript(
    ([nsec, theme]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.theme", theme);
    },
    [FOUNDER_NSEC, theme],
  );
  await relay.install(page);
  await page.goto("/projects");
  await page
    .getByRole("button", { name: "Pitch a project", exact: true })
    .first()
    .click();
  return page.getByRole("dialog", { name: "Pitch a project" });
}

async function fillProject(page: Page, name = "Neptune") {
  await page.getByLabel("Project name", { exact: true }).fill(name);
  await page
    .getByLabel("One-line pitch", { exact: true })
    .fill("A telescope network.");
}

test("pitch steps keep drafts and publish the displayed roles through the real write path", async ({
  page,
}) => {
  const relay = createMockRelay();
  const dialog = await openPitch(page, relay);
  await expect(page.getByLabel("Project name", { exact: true })).toBeFocused();
  await fillProject(page);
  await page
    .getByLabel("Description", { exact: true })
    .fill("Build it with us.");
  // Enter and the visible Continue button are the same form action.
  await page.getByLabel("One-line pitch", { exact: true }).press("Enter");
  await expect(page.getByLabel("Your role", { exact: true })).toBeFocused();
  await page.getByLabel("Stake for your role", { exact: true }).fill("35");
  await page.getByRole("button", { name: "Add a role", exact: true }).click();
  await page.getByLabel("Role 2", { exact: true }).fill("Designer");
  await page.getByLabel("Stake for role 2", { exact: true }).fill("8");
  await expect(page.getByTestId("pitch-pool")).toHaveText(
    "55% of 100% declared",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Neptune",
  );
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Build it with us.",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByLabel("Stake for your role", { exact: true }),
  ).toHaveValue("35");
  await expect(page.getByLabel("Role 2", { exact: true })).toHaveValue(
    "Designer",
  );
  await page
    .getByRole("button", { name: "Remove role The writer", exact: true })
    .click();
  await expect(page.getByLabel("Role 1", { exact: true })).toHaveValue(
    "Designer",
  );
  await expect(page.getByTestId("pitch-pool")).toHaveText(
    "43% of 100% declared",
  );
  await page.getByLabel("Stake for role 1", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`/projects/neptune\\?author=${FOUNDER}`),
  );
  const nodes = relay.events.filter((event) => event.kind === 37010);
  const pitches = relay.events.filter((event) => event.kind === 37015);
  expect(nodes).toHaveLength(1);
  expect(pitches).toHaveLength(1);
  expect(pitches[0].tags).toContainEqual([
    "role",
    "the-founder",
    "The founder",
    "35",
  ]);
  expect(pitches[0].tags).toContainEqual(["role", "designer", "Designer", "8"]);
  expect(JSON.parse(pitches[0].content)).toMatchObject({
    summary: "A telescope network.",
    description: "Build it with us.",
  });
});

test("pitch project validation reveals the address and keeps focus beside the error", async ({
  page,
}) => {
  const relay = createMockRelay();
  await openPitch(page, relay);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("pitch-name-error")).toHaveText(
    "Give your project a name.",
  );
  await expect(page.getByLabel("Project name", { exact: true })).toBeFocused();
  await fillProject(page);
  await page.getByText("Customize page address", { exact: true }).click();
  await page.getByLabel("Project id", { exact: true }).fill("INVALID ADDRESS");
  await page.getByText("Customize page address", { exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const address = page.getByLabel("Project id", { exact: true });
  await expect(address).toBeVisible();
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute(
    "aria-describedby",
    "pitch-id-feedback",
  );
  await expect(page.getByTestId("pitch-id-error")).toContainText(
    "Project id must",
  );
  expect(
    relay.events.filter((event) => [37010, 37015].includes(event.kind)),
  ).toHaveLength(0);
  await address.fill("custom-neptune");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(address).toHaveValue("custom-neptune");
});

for (const source of ["team", "launch"] as const) {
  test(`pitching from an existing ${source} keeps its identity and filters the picker to your records`, async ({
    page,
  }) => {
    const relay = createMockRelay();
    const owned = source === "team" ? nodeEvent() : launchEvent();
    const stranger = {
      ...owned,
      id: "stranger",
      pubkey: ALICE,
      tags: owned.tags.map((tag) =>
        tag[0] === "d"
          ? ["d", "someone-else"]
          : tag[0] === "name"
            ? ["name", "Someone else's project"]
            : tag,
      ),
    };
    relay.seed(owned);
    relay.seed(stranger);
    await openPitch(page, relay);
    await page
      .getByRole("button", {
        name: source === "team" ? "Existing team" : "From a launch",
        exact: true,
      })
      .click();
    const picker = page.getByLabel(source === "team" ? "Your team" : "Launch", {
      exact: true,
    });
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeDisabled();
    await expect(picker.locator('option[value="nebula"]')).toHaveCount(1);
    await expect(picker.locator('option[value="someone-else"]')).toHaveCount(0);
    await picker.selectOption("nebula");
    if (source === "launch")
      await expect(
        page.getByLabel("Project name", { exact: true }),
      ).toHaveValue("Nebula");
    await fillProject(page, "Nebula");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish pitch", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Pitch a project" }),
    ).toHaveCount(0);
    const pitch = relay.events.find((event) => event.kind === 37015);
    expect(pitch?.tags).toContainEqual(["d", "nebula"]);
    expect(
      relay.events.filter(
        (event) =>
          event.kind === 37010 && !["node-1", "stranger"].includes(event.id),
      ),
    ).toHaveLength(source === "team" ? 0 : 1);
  });
}

test("a partial pitch publish retries only the pitch and lands on the finished project", async ({
  page,
}) => {
  let refusePitch = true;
  const relay = createMockRelay({
    refuse: (event) =>
      event.kind === 37015 && refusePitch ? "Temporarily unavailable" : null,
  });
  const dialog = await openPitch(page, relay);
  await fillProject(page);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Publish pitch", exact: true })
    .click();
  await expect(page.getByTestId("pitch-partial-error")).toContainText(
    "isn't on the board yet",
  );
  await expect(page.getByTestId("pitch-partial-error")).toBeInViewport();
  await expect(page.getByLabel("Your role", { exact: true })).toHaveValue(
    "The founder",
  );
  expect(relay.events.filter((event) => event.kind === 37010)).toHaveLength(1);
  refusePitch = false;
  await page
    .getByRole("button", { name: "Retry the pitch", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`/projects/neptune\\?author=${FOUNDER}`),
  );
  expect(relay.events.filter((event) => event.kind === 37010)).toHaveLength(1);
  expect(relay.events.filter((event) => event.kind === 37015)).toHaveLength(1);
});

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 640 },
]) {
  for (const theme of ["light", "dark"]) {
    test(`pitch fields align and actions stay visible at ${viewport.width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const relay = createMockRelay();
      const dialog = await openPitch(page, relay, theme);
      await fillProject(page);
      const headingColor = await dialog
        .locator("h2")
        .evaluate((element) => getComputedStyle(element).color);
      for (const label of [
        dialog.getByRole("button", { name: "New project", exact: true }),
        dialog.getByTestId("wizard-stepper").locator("> p"),
      ]) {
        expect(
          await label.evaluate((element) => getComputedStyle(element).color),
        ).toBe(headingColor);
      }
      await waitForAnimations(page);
      await dialog.screenshot({
        path: testInfo.outputPath("pitch-project.png"),
      });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      // Space activates the focused button, just as a pointer does.
      const add = page.getByRole("button", { name: "Add a role", exact: true });
      await add.focus();
      await add.press("Space");
      await page.getByLabel("Role 2", { exact: true }).fill("Designer");
      await page.getByLabel("Stake for role 2", { exact: true }).fill("8");
      const rows = page.getByTestId(/pitch-role-row-/);
      await expect(rows).toHaveCount(3);
      const rects = await rows.evaluateAll((rows) =>
        rows.map((row) => {
          const [name, stake] = row.querySelectorAll("input");
          const a = name.getBoundingClientRect();
          const b = stake.getBoundingClientRect();
          return {
            nameY: a.y,
            stakeY: b.y,
            nameH: a.height,
            stakeH: b.height,
            stakeX: b.x,
          };
        }),
      );
      for (const rect of rects) {
        expect(Math.abs(rect.nameY - rect.stakeY)).toBeLessThan(1);
        expect(rect.nameH).toBe(rect.stakeH);
        expect(Math.abs(rect.stakeX - rects[0].stakeX)).toBeLessThan(1);
      }
      const publish = page.getByRole("button", {
        name: "Publish pitch",
        exact: true,
      });
      const footer = await publish.boundingBox();
      if (!footer) throw new Error("Publish action is missing");
      expect(footer.y + footer.height).toBeLessThanOrEqual(
        viewport.height - 16,
      );
      const width = await dialog.evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(width.scroll).toBeLessThanOrEqual(width.width);
      expect(width.page).toBeLessThanOrEqual(viewport.width);
      const scroll = page.getByTestId("pitch-form-scroll");
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
      });
      await waitForAnimations(page);
      await dialog.screenshot({ path: testInfo.outputPath("pitch-team.png") });
      // More roles must grow only the scroll area; the final action stays put.
      for (let n = 0; n < 4; n++) await add.click();
      const metrics = await scroll.evaluate((element) => ({
        client: element.clientHeight,
        scroll: element.scrollHeight,
      }));
      expect(metrics.scroll).toBeGreaterThan(metrics.client);
      await scroll.focus();
      await scroll.press("PageDown");
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      const after = await publish.boundingBox();
      expect(after?.y).toBe(footer.y);
      // Closing returns focus to the form's opener.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(
        page
          .getByRole("button", { name: "Pitch a project", exact: true })
          .first(),
      ).toBeFocused();
    });
  }
}
