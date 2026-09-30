import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Accessibility gate.
 *
 * Runs axe on the main surfaces and fails on `serious` and `critical`
 * violations, which are the ones a keyboard or screen-reader user cannot work
 * around. `moderate` and `minor` findings are reported by the tool but not
 * gated here, so this stays a signal rather than noise.
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

async function mockRelay(page: Page, options?: { failReads?: boolean }) {
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: "alpha.example.com",
            name: "Alpha",
            description: "A test community.",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    });
  });
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    // Challenge like the relay does, so an authenticated client does not read a
    // refusal as "you were not authenticated yet" and retry.
    ws.send(JSON.stringify(["AUTH", "challenge"]));
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "AUTH") {
        ws.send(JSON.stringify(["OK", parsed[1].id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      const kinds = filter.kinds ?? [];
      if (options?.failReads && !kinds.includes(39000)) {
        // The failure states are part of the UI; axe has to see them too.
        ws.send(
          JSON.stringify([
            "CLOSED",
            subId,
            "blocked: the relay refused this read",
          ]),
        );
        return;
      }
      if (kinds.includes(39000)) {
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: "chan-event-1",
              pubkey: "b".repeat(64),
              created_at: 100,
              kind: 39000,
              tags: [
                ["d", CHANNEL_ID],
                ["name", "general"],
              ],
              content: "",
              sig: "sig",
            },
          ]),
        );
      }
      if (kinds.includes(44010)) {
        // A roster row, so the agents and org views render content.
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: "a".repeat(64),
              pubkey: "1".repeat(64),
              created_at: 205,
              kind: 44010,
              tags: [["d", "1".repeat(64)]],
              content: JSON.stringify({
                name: "buzz-tab",
                runtype: "browser",
                status: "available",
                tools: ["chat"],
                team: "Platform",
                heartbeat: 205,
              }),
              sig: "sig",
            },
          ]),
        );
      }
      if (kinds.includes(44011)) {
        // A task, so the board renders cards rather than only its empty state.
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: "f".repeat(64),
              pubkey: "b".repeat(64),
              created_at: 210,
              kind: 44011,
              tags: [
                ["d", "task-1"],
                ["h", CHANNEL_ID],
                ["p", "b".repeat(64)],
              ],
              content: JSON.stringify({
                title: "Ship the work board",
                description: "With a description",
                status: "open",
              }),
              sig: "sig",
            },
          ]),
        );
      }
      if (kinds.includes(9)) {
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: "e".repeat(64),
              pubkey: "b".repeat(64),
              created_at: 200,
              kind: 9,
              tags: [["h", CHANNEL_ID]],
              content: "A message with a [[wikilink]] and #tag",
              sig: "sig",
            },
          ]),
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

async function expectAccessible(page: Page, surface: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
      // The element itself and the measured reason: a bare selector sends the
      // next reader hunting through the DOM for what axe actually objected to.
      html: v.nodes.slice(0, 2).map((n) => n.html.slice(0, 200)),
      why: v.nodes[0]?.failureSummary?.replace(/\s+/g, " ").slice(0, 300),
    })),
    `${surface}: serious/critical accessibility violations`,
  ).toEqual([]);
}

test.use({ viewport: { width: 1280, height: 900 } });

test("the discovery landing is accessible", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/c");
  await expect(
    page.getByRole("heading", { name: "Communities" }),
  ).toBeVisible();
  await expectAccessible(page, "landing");
});

test("the channel shell and timeline are accessible", async ({ page }) => {
  await mockRelay(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByText("A message with a")).toBeVisible();
  await expectAccessible(page, "channel");
});

test("a failed read is accessible", async ({ page }) => {
  await mockRelay(page, { failReads: true });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByTestId("timeline-load-error")).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, "channel (read failed)");

  await page.getByTestId("wiki-toggle").click();
  await expect(page.getByTestId("wiki-load-error")).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, "wiki (read failed)");
});

test("the wiki is accessible", async ({ page }) => {
  await mockRelay(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("wiki-toggle").click();
  await expect(page.getByTestId("wiki-page-list")).toBeVisible();
  await expectAccessible(page, "wiki");
});

test("the invite landing is accessible", async ({ page }) => {
  await mockRelay(page);
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });
  await page.goto("/invite/demo-code");
  // A link when the relay publishes no join policy, a button when it does.
  await expect(page.getByText("Accept invite in Creaton").first()).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, "invite");
});

test("the repository browser is accessible", async ({ page }) => {
  // Reached through the directory rather than directly, so the page gets
  // whatever state the relay gave it — including the failure state it shows
  // when the read does not answer.
  await mockRelay(page);
  await page.goto("/repos");
  await expect(page.getByRole("heading").first()).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, "repositories");
});

test("the launchpad is accessible", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/launchpad");
  await expect(page.getByRole("heading", { name: "Launchpad" })).toBeVisible();
  await expectAccessible(page, "launchpad");
});

test("the work board is accessible", async ({ page }) => {
  await mockRelay(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("work-toggle").click();
  // Scoped: the board renders the title on a card and in the list beside it.
  await expect(page.getByText("Ship the work board").first()).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, "work board");
});

test("the org view is accessible", async ({ page }) => {
  await mockRelay(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("org-toggle").click();
  await expect(page.getByText("buzz-tab").first()).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, "org");
});

test("search results are accessible", async ({ page }) => {
  await mockRelay(page);
  // Search goes through the HTTP bridge (NIP-50), not the socket.
  await page.route("**/query", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "e".repeat(64),
          pubkey: "b".repeat(64),
          // Two hours old, so the result's age can be asserted rather than assumed.
          created_at: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
          kind: 9,
          tags: [["h", CHANNEL_ID]],
          content: "A message with a [[wikilink]] and #tag",
          sig: "sig",
        },
      ]),
    });
  });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("search-input").fill("wikilink");
  await page.keyboard.press("Enter");
  // Results, not the channel view again: the seeded message matches.
  await expect(page.getByTestId("search-result").first()).toBeVisible({
    timeout: 20_000,
  });
  // The age, not "just now": the result passed milliseconds where the formatter
  // takes seconds, which rendered every hit as brand new.
  await expect(page.getByTestId("search-result").first()).toContainText(
    "2 hours ago",
  );
  await expectAccessible(page, "search");
});

test("the agents view is accessible", async ({ page }) => {
  await mockRelay(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("fleet-toggle").click();
  await expect(page.getByTestId("browser-agent-toggle")).toBeVisible();
  await expectAccessible(page, "fleet");
});
