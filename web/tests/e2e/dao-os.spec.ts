import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { COMMUNITY_HOST, createMockRelay, matches } from "./mock-relay";
import { waitForAnimations } from "../helpers/animations";
import { expectAccessible } from "../helpers/a11y";

const KEY = "4".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(KEY, "hex")));
const AGENT = "d".repeat(64);
const OTHER = "e".repeat(64);
const CHANNEL = "0f0f0f0f-1111-2222-3333-444444444444";
const COORD = `37001:${ME}:nebula-os`;
let sequence = 0;
const event = (
  kind: number,
  pubkey: string,
  content: unknown,
  tags: string[][] = [],
  at?: number,
) => {
  sequence += 1;
  return {
    id: sequence.toString(16).padStart(64, "0"),
    kind,
    pubkey,
    content: typeof content === "string" ? content : JSON.stringify(content),
    tags,
    created_at: at ?? 1700000000 + sequence,
    sig: "0".repeat(128),
  };
};

function seed(relay: ReturnType<typeof createMockRelay>) {
  relay.seed(
    event(39000, ME, "", [
      ["d", CHANNEL],
      ["name", "build-room"],
    ]),
  );
  relay.seed(
    event(
      37001,
      ME,
      { pitch: "Build a useful app together.", stage: "draft" },
      [
        ["d", "nebula-os"],
        ["name", "Nebula OS"],
        ["t", "dao-launchpad"],
        ["buzz-channel", CHANNEL],
        ["team", ME, "Founder"],
      ],
    ),
  );
  relay.seed(
    event(
      47003,
      ME,
      {
        title: "Beta demo shipped",
        body: "The demo is at https://example.com/demo. Thanks to the builders.",
      },
      [["a", COORD]],
    ),
  );
  relay.seed(
    event(47003, OTHER, { title: "Fake official update", body: "Untrusted" }, [
      ["a", COORD],
    ]),
  );
  relay.seed(
    event(
      44011,
      ME,
      {
        title: "Ship the demo",
        description: "A working demo for people to try.",
        status: "needs_approval",
        milestone: "Public beta",
      },
      [
        ["d", "demo-task"],
        ["p", AGENT],
        ["h", CHANNEL],
      ],
    ),
  );
  relay.seed(
    event(
      44010,
      AGENT,
      {
        name: "Demo helper",
        status: "busy",
        heartbeat: Math.floor(Date.now() / 1000),
        tools: ["shell"],
      },
      [["d", "demo-agent"]],
    ),
  );
  relay.seed(
    event(
      37012,
      ME,
      {
        subject: AGENT,
        window: "day",
        limits: { runs: 10, spend: { amount: 500, unit: "usd-cents" } },
        onchain: { contract: `0x${"1".repeat(40)}` },
      },
      [["d", "helper-budget"]],
    ),
  );
  relay.seed(
    event(
      37010,
      ME,
      {
        name: "Builder",
        kind: "agent_seat",
        holders: [ME],
        agentSeats: [AGENT],
        scope: { readBelow: true, assignBelow: false, canGrant: [] },
      },
      [["d", "builder-seat"]],
    ),
  );
}

async function install(page: Page, relay: ReturnType<typeof createMockRelay>) {
  await relay.install(page);
  await page.addInitScript((key) => {
    localStorage.setItem("buzz.identity.nsec", key);
    localStorage.setItem("buzz.identity.backedUp", "1");
  }, KEY);
  await page.route("**/communities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: COMMUNITY_HOST,
            name: "Alpha",
            description: "Build together",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    }),
  );
  await page.route("**/query", (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        relay.events.filter((e) =>
          filters.some((f: Parameters<typeof matches>[0]) => matches(f, e)),
        ),
      ),
    });
  });
}

test("Home connects project reports, reading history, discussion and the four main destinations", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay);
  await page.goto("/");
  await page.getByTestId("social-tab-projects").click();
  const progress = page.getByTestId("project-progress");
  await expect(progress).toContainText("Beta demo shipped");
  await expect(progress).not.toContainText("Fake official update");
  await expect(progress).toContainText("From the team");
  await expectAccessible(page, "Home project progress cards");
  await expect(
    progress.getByRole("link", { name: "Artifact 1" }),
  ).toHaveAttribute("href", "https://example.com/demo");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await progress.getByRole("button", { name: "Copy update link" }).click();
  await expect(progress).toContainText("Could not copy the link");
  const nav = page.getByTestId("app-nav");
  for (const name of ["Home", "Discover", "Communities", "Portfolio"])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await progress.getByRole("link", { name: "Nebula OS", exact: true }).click();
  await expect(page.getByTestId("project-delivery-overview")).toContainText(
    "Ship the demo",
  );
  await expect(page.getByTestId("project-progress")).toContainText(
    "Beta demo shipped",
  );
  await page.goto("/");
  relay.seed(
    event(
      47003,
      ME,
      { title: "Second release", body: "A new demo, with review notes." },
      [["a", COORD]],
      1900000000,
    ),
  );
  await page.reload();
  await page.getByTestId("social-tab-projects").click();
  await expect(page.getByTestId("project-progress")).toContainText(
    "1 new to you",
  );
  await page
    .getByTestId("project-progress")
    .getByRole("button", { name: "Mark shown updates as read" })
    .click();
  await expect(page.getByTestId("project-progress")).not.toContainText(
    "New to you",
  );
  await page
    .getByTestId("project-progress")
    .getByRole("link", { name: "Discuss project" })
    .first()
    .click();
  await expect(page.getByTestId("launch-discussion")).toBeVisible();
});

test("marking reports from multiple projects uses one atomic reading-history write", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  const second = `37001:${ME}:second-project`;
  relay.seed(
    event(37001, ME, { pitch: "Another useful project", stage: "draft" }, [
      ["d", "second-project"],
      ["name", "Second project"],
      ["t", "dao-launchpad"],
    ]),
  );
  relay.seed(
    event(47003, ME, { title: "Second project ships", body: "An update" }, [
      ["a", second],
    ]),
  );
  await install(page, relay);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    const state = window as Window & { readingWrites?: number };
    state.readingWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (key === "creaton.progress-seen.v1") {
        state.readingWrites = (state.readingWrites ?? 0) + 1;
        if (state.readingWrites > 1)
          throw new Error("Refuse a second partial persist");
      }
      return original.call(this, key, value);
    };
  });
  await page.goto("/");
  await page.getByTestId("social-tab-projects").click();
  const progress = page.getByTestId("project-progress");
  await expect(progress).toContainText("Beta demo shipped");
  await expect(progress).toContainText("Second project ships");
  await progress
    .getByRole("button", { name: "Mark shown updates as read" })
    .click();
  await expect(progress).toContainText("marked as read in this browser");
  const saved = await page.evaluate(() => ({
    count: (window as Window & { readingWrites?: number }).readingWrites,
    history: JSON.parse(
      localStorage.getItem("creaton.progress-seen.v1") ?? "{}",
    ),
  }));
  expect(saved.count).toBe(1);
  expect(Object.keys(saved.history)).toHaveLength(2);
});

test("task links persist through status changes and connect output to the project without a transfer", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay);
  await page.goto(`/c/${COMMUNITY_HOST}?view=work&work=${ME}:demo-task`);
  const panel = page.getByTestId("task-delivery");
  await expect(panel).toBeVisible();
  await panel.getByTestId("task-delivery-project").selectOption(COORD);
  await panel
    .getByTestId("task-delivery-output")
    .fill("https://example.com/demo");
  await panel.getByTestId("task-delivery-save").click();
  await expect(panel).toContainText("No payment was sent");
  await expectAccessible(page, "Task delivery references");
  const row = relay.events.filter((e) => e.kind === 44011).at(-1);
  expect(JSON.parse(row?.content ?? "{}").delivery.output).toBe(
    "https://example.com/demo",
  );
  expect(row?.tags).toContainEqual(["a", COORD]);
  expect(row?.tags).toContainEqual(["h", CHANNEL]);
  expect(relay.events.some((e) => e.kind === 37004)).toBe(false);
  await page.reload();
  await expect(page.getByTestId("task-delivery-output")).toHaveValue(
    "https://example.com/demo",
  );
  await page.getByRole("link", { name: "Open project", exact: true }).click();
  await expect(page.getByTestId("project-delivery-overview")).toContainText(
    "Ship the demo",
  );
  await page
    .getByTestId("project-delivery-overview")
    .getByRole("button", { name: "People & agents" })
    .click();
  const agent = page.getByTestId("project-agent-card");
  await expect(agent).toContainText("Demo helper");
  await expect(agent).toContainText("managed by");
  await expect(agent).toContainText("Ship the demo");
  await expect(agent.getByRole("link", { name: "Output" })).toHaveAttribute(
    "href",
    "https://example.com/demo",
  );
  await expect(agent.getByTestId("agent-budget-context")).toContainText(
    "allowance not verified here",
  );
  await expectAccessible(page, "Project agent supervision");
});

test("outside tasks, forged edits and claim evidence cannot become team work or project agents", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  const injectedAgent = "c".repeat(64);
  const attempts: Array<[string, string, string | null]> = [
    ["outsider", injectedAgent, null],
    ["spoof-assignee", ME, CHANNEL],
  ];
  for (const [id, assignee, channel] of attempts) {
    relay.seed(
      event(
        44011,
        OTHER,
        {
          title: `Injected work ${id}`,
          status: "needs_approval",
          delivery: {
            project: COORD,
            output: "https://attacker.example",
            claim: null,
          },
        },
        [
          ["d", id],
          ["p", assignee],
          ["a", COORD],
          ...(channel ? [["h", channel]] : []),
        ],
      ),
    );
  }
  relay.seed(
    event(
      44011,
      OTHER,
      {
        title: "Forged finished demo",
        status: "done",
        delivery: {
          project: COORD,
          output: "https://attacker.example",
          claim: null,
        },
      },
      [
        ["d", "demo-task"],
        ["p", AGENT],
        ["h", CHANNEL],
        ["a", COORD],
      ],
      1900000000,
    ),
  );
  relay.seed(
    event(44010, injectedAgent, { name: "Injected helper", tools: [] }, [
      ["d", "injected-agent"],
    ]),
  );
  relay.seed(
    event(
      37012,
      OTHER,
      {
        subject: AGENT,
        window: "day",
        limits: { runs: 999999 },
      },
      [["d", "fake-budget"]],
    ),
  );
  relay.seed(
    event(
      47003,
      OTHER,
      {
        title: "Stranger claim evidence",
        body: "I approve this",
        claim: { id: `0x${"1".repeat(64)}`, mandate: `0x${"2".repeat(40)}` },
      },
      [["a", COORD]],
    ),
  );
  await install(page, relay);
  await page.goto(`/launchpad/nebula-os?author=${ME}`);
  const overview = page.getByTestId("project-delivery-overview");
  await expect(overview).toContainText("Ship the demo");
  await expect(overview).toContainText("Needs review");
  await expect(overview).not.toContainText("Injected work");
  await expect(overview).not.toContainText("Forged finished demo");
  await expect
    .poll(
      () =>
        relay.subscriptionFilters().filter((f) => f.kinds?.includes(44011))
          .length,
    )
    .toBeGreaterThan(0);
  const taskFilters = relay
    .subscriptionFilters()
    .filter((f) => f.kinds?.includes(44011));
  expect(
    taskFilters.every(
      (f) =>
        Array.isArray(f.authors) &&
        f.authors.includes(ME) &&
        (f["#a"] || f["#h"] || f["#d"]),
    ),
  ).toBe(true);
  await expect(page.getByTestId("project-progress")).not.toContainText(
    "Stranger claim evidence",
  );
  await overview.getByRole("button", { name: "People & agents" }).click();
  await expect(page.getByTestId("project-agents")).toContainText("Demo helper");
  await expect(page.getByTestId("project-agents")).not.toContainText(
    "Injected helper",
  );
  await expect(page.getByTestId("project-agents")).not.toContainText(
    "Forged finished demo",
  );
  await expect(page.getByTestId("agent-budget-context")).toContainText("10");
  await expect(page.getByTestId("agent-budget-context")).not.toContainText(
    "999999",
  );
});

test("agent-record retry keeps the page and active project tab", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  relay.setClosingSockets((f) => f?.kinds?.includes(44010) ?? false);
  await install(page, relay);
  await page.goto(`/launchpad/nebula-os?author=${ME}&tab=agents`);
  await page.evaluate(() => {
    (window as Window & { retryMarker?: string }).retryMarker = "same-document";
  });
  const reload = page.getByRole("button", { name: "Reload records" });
  await expect(reload).toBeEnabled();
  relay.setClosingSockets(false);
  await reload.click();
  await expect(page.getByTestId("project-agent-card")).toContainText(
    "Demo helper",
  );
  expect(
    await page.evaluate(
      () => (window as Window & { retryMarker?: string }).retryMarker,
    ),
  ).toBe("same-document");
  await expect(page).toHaveURL(/tab=agents/);
});

test("the project-first experience fits a phone and preserves readable actions", async ({
  page,
}, testInfo) => {
  const relay = createMockRelay();
  seed(relay);
  await install(page, relay);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/launchpad/nebula-os?author=${ME}`);
  await expect(page.getByTestId("project-delivery-overview")).toBeVisible();
  await expect(page.getByTestId("project-progress-item")).toContainText(
    "Beta demo shipped",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await waitForAnimations(page);
  await page.screenshot({
    path: testInfo.outputPath("creaton-os-project-phone.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("app-nav-start")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: testInfo.outputPath("creaton-os-project-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  // On a phone Start is a tab in the bottom bar (D108), and the bar still fits a 320-wide screen. Wait for the phone
  // layout itself: the wide bar has a Start link too, and is still mounted for a moment after the resize.
  await expect(page.getByTestId("app-nav")).toHaveAttribute(
    "data-layout",
    "phone",
  );
  await expect(page.getByTestId("app-nav-start")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .map((el) => ({
        tag: el.tagName,
        cls: el.className,
        text: el.textContent?.slice(0, 60),
        right: el.getBoundingClientRect().right,
      }))
      .slice(-12),
  }));
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(
    overflow.width,
  );
  await waitForAnimations(page);
  await page.screenshot({
    path: testInfo.outputPath("creaton-os-project-small-dark.png"),
    fullPage: true,
  });
});

test("a refused task-link save preserves the draft and offers an actual retry", async ({
  page,
}) => {
  let refuse = true;
  const relay = createMockRelay({
    refuse: (e) =>
      refuse && e.kind === 44011
        ? "The task update was refused. Try again."
        : null,
  });
  seed(relay);
  await install(page, relay);
  await page.goto(`/c/${COMMUNITY_HOST}?view=work&work=${ME}:demo-task`);
  const panel = page.getByTestId("task-delivery");
  await panel.getByTestId("task-delivery-project").selectOption(COORD);
  await panel
    .getByTestId("task-delivery-output")
    .fill("https://example.com/retained-draft");
  await panel.getByTestId("task-delivery-save").click();
  await expect(panel).toContainText("The task update was refused");
  await expect(panel.getByTestId("task-delivery-output")).toHaveValue(
    "https://example.com/retained-draft",
  );
  refuse = false;
  await panel.getByTestId("task-delivery-save").click();
  await expect(panel).toContainText("Delivery links saved");
});

test("a shared update link opens and focuses a report beyond the first preview", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  const original = relay.events.find(
    (e) => e.kind === 47003 && e.pubkey === ME,
  );
  if (!original) throw new Error("Missing original report fixture");
  for (let n = 0; n < 8; n++)
    relay.seed(
      event(
        47003,
        ME,
        { title: `Later release ${n}`, body: "A later report." },
        [["a", COORD]],
        1900000000 + n,
      ),
    );
  await install(page, relay);
  await page.goto(
    `/launchpad/nebula-os?author=${ME}&tab=updates#update-${original.id}`,
  );
  const report = page.locator(`[id="update-${original.id}"]`);
  await expect(report).toContainText("Beta demo shipped");
  await expect(report).toBeFocused();
  await report.getByRole("link", { name: "Discuss project" }).click();
  await expect(page.getByTestId("launch-discussion")).toBeVisible();
  await page.getByRole("tab", { name: "Updates" }).click();
  await expect(page).toHaveURL(/tab=updates/);
  await expect(page.getByTestId("project-progress")).toBeVisible();
});
