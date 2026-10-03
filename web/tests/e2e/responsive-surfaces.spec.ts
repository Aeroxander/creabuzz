import { expect, test, type Page } from "@playwright/test";

/**
 * Narrow-viewport audit (roadmap item A, surfaces beyond the shell).
 *
 * Each surface is rendered at 390x844 and checked for page-level horizontal
 * overflow — the failure mode that produced the original "unreadable sliver".
 * Screenshots land in `test-results/responsive/` for review.
 */

const MOBILE = { width: 390, height: 844 };
const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const AGENT = "c".repeat(64);
const FOUNDER = "a".repeat(64);

const directory = {
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
};

function event(kind: number, tags: string[][], content = "", id = `${kind}-1`) {
  return {
    id,
    pubkey: kind === 37001 ? FOUNDER : "b".repeat(64),
    created_at: 100,
    kind,
    tags,
    content,
    sig: "sig",
  };
}

const BY_KIND: Record<number, unknown> = {
  39000: event(
    39000,
    [
      ["d", CHANNEL_ID],
      ["name", "general"],
      ["about", "General chatter"],
    ],
    "",
    "chan-1",
  ),
  44010: event(
    44010,
    [
      ["d", "buzz-tabs"],
      ["name", "buzz-tabs"],
      ["runtype", "browser"],
    ],
    JSON.stringify({ model: "deepseek-v3" }),
    "agent-1",
  ),
  44011: event(
    44011,
    [
      ["d", "task-1"],
      ["title", "Wire the launchpad taps"],
      ["status", "open"],
      ["p", AGENT],
    ],
    JSON.stringify({ title: "Wire the launchpad taps" }),
    "task-1",
  ),
  1621: event(
    1621,
    [
      ["d", "issue-1"],
      ["title", "Kanban drops lose the channel"],
      ["subject", "Kanban drops lose the channel"],
    ],
    "Drops from a channel-tied task never reach the board.",
    "issue-1",
  ),
  44100: event(44100, [["p", AGENT]], "", "notice-1"),
  37001: event(
    37001,
    [
      ["d", "nebula"],
      ["name", "Nebula DAO"],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
      ["chain", "11155111"],
    ],
    JSON.stringify({ pitch: "To the stars.", stage: "live" }),
    "record-1",
  ),
};

async function mockRelay(page: Page) {
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(directory),
    });
  });
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
      for (const kind of filter.kinds ?? []) {
        const payload = BY_KIND[kind];
        if (payload) ws.send(JSON.stringify(["EVENT", subId, payload]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

/** Page-level horizontal overflow: nothing should stick out past the viewport. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      innerWidth: window.innerWidth,
      widest: [...document.querySelectorAll("body *")]
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            right: Math.round(rect.right),
            cls: String(el.className).slice(0, 60),
          };
        })
        // 1px of rounding tolerance; only real overhang matters.
        .filter((r) => r.right > window.innerWidth + 1)
        .slice(0, 5),
    };
  });
}

/** Controls that are clipped out of the viewport cannot be reached at all. */
async function expectNoClippedControls(page: Page, container: string) {
  const containers = await page.locator(container).count();
  expect(
    containers,
    `no element matched ${container}, so the clipping check proves nothing`,
  ).toBeGreaterThan(0);
  const clipped = await page
    .locator(`${container} button`)
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            label: (node.getAttribute("aria-label") || node.textContent || "")
              .trim()
              .slice(0, 24),
            right: Math.round(rect.right),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
          };
        })
        .filter(
          (r) =>
            r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1),
        ),
    );
  expect(
    clipped,
    `controls clipped out of the viewport: ${JSON.stringify(clipped)}`,
  ).toEqual([]);
}

async function expectNoOverflow(page: Page, surface: string) {
  const result = await overflow(page);
  expect(
    result.scrollWidth,
    `${surface}: document scrollWidth ${result.scrollWidth} > ${result.innerWidth}; widest offenders ${JSON.stringify(result.widest)}`,
  ).toBeLessThanOrEqual(result.innerWidth + 1);
}

async function openCommunity(page: Page) {
  await mockRelay(page);
  await page.goto("/c/alpha.example.com");
  await expect(page.getByTestId("content-pane")).toBeVisible();
}

async function shot(page: Page, name: string) {
  // Let slide-overs finish and first queries land, so the capture shows the
  // settled surface rather than a transition frame or a loading skeleton.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-results/responsive/${name}.png` });
}

test.use({ viewport: MOBILE });

test("landing page has no horizontal overflow", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/c");
  await expect(
    page.getByRole("heading", { name: "Communities" }),
  ).toBeVisible();
  await expectNoOverflow(page, "landing");
  await shot(page, "10-mobile-landing");
});

test("channel view and composer fit", async ({ page }) => {
  await openCommunity(page);
  await page.getByTestId("open-channel-list").click();
  await page
    .getByRole("button", { name: /general/ })
    .first()
    .click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expectNoOverflow(page, "channel");
  await shot(page, "11-mobile-channel-composer");
});

test("notifications panel fits", async ({ page }) => {
  await openCommunity(page);
  // The bell lives in the channel list, which is off-canvas on a phone.
  await page.getByTestId("open-channel-list").click();
  await page
    .getByTestId("notifications-bell")
    .getByRole("button")
    .first()
    .click();
  await expectNoOverflow(page, "notifications");
  await shot(page, "12-mobile-notifications");
});

test("fleet view fits", async ({ page }) => {
  await openCommunity(page);
  await page.getByTestId("open-channel-list").click();
  await page.getByTestId("fleet-toggle").click();
  await expectNoOverflow(page, "fleet");
  await shot(page, "13-mobile-fleet");
});

test("work board fits", async ({ page }) => {
  await openCommunity(page);
  await page.getByTestId("open-channel-list").click();
  await page.getByTestId("work-toggle").click();
  await expectNoOverflow(page, "work");
  await shot(page, "14-mobile-work");
});

test("org view fits", async ({ page }) => {
  await openCommunity(page);
  await page.getByTestId("open-channel-list").click();
  await page.getByTestId("org-toggle").click();
  await expectNoOverflow(page, "org");
  await shot(page, "15-mobile-org");
});

test("first-run identity prompt fits", async ({ page }) => {
  await openCommunity(page);
  // On a phone the identity prompt lives in the app's bottom tab bar.
  await page.getByTestId("create-identity-cta").click();
  await expectNoOverflow(page, "first-run identity");
  await shot(page, "16-mobile-first-run-identity");
});

test("profile menu fits once an identity exists", async ({ page }) => {
  // The user chip only renders for a stored identity; seed one so the menu
  // (not the first-run CTA) is what gets audited.
  await page.addInitScript(() => {
    window.localStorage.setItem("buzz.identity.nsec", "1".repeat(64));
  });
  await openCommunity(page);
  // On a phone the profile menu lives in the app's bottom tab bar.
  await page.getByTestId("user-chip").click();
  await expectNoOverflow(page, "profile");
  await shot(page, "16b-mobile-profile");
});

test("launchpad directory fits", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/launchpad");
  await expect(page.getByRole("heading", { name: "Launchpad" })).toBeVisible();
  await expectNoOverflow(page, "launchpad directory");
  await shot(page, "17-mobile-launchpad");
});

test("launchpad create dialog fits", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/launchpad");
  await page
    .getByRole("button", { name: /Set up a sale/ })
    .first()
    .click();
  await expectNoOverflow(page, "launchpad create");
  await shot(page, "18-mobile-launchpad-create");
});

test("wiki typing still lands in the document", async ({ page }) => {
  // Guards the local-edit splice: the editor hands over a whole document on
  // every keystroke, and only the changed range may be written to the shared
  // Yjs text.
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: "alpha.example.com",
            name: "Alpha",
            description: "d",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    });
  });
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
      for (const kind of filter.kinds ?? []) {
        const payload = BY_KIND[kind];
        if (payload) ws.send(JSON.stringify(["EVENT", subId, payload]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("open-channel-list").click();
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("wiki-new-page").click();
  await page.getByTestId("page-name-input").fill("release-notes");
  await page.getByTestId("page-name-confirm").click();

  const editor = page.getByTestId("wiki-wysiwyg").locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("Hello wiki");
  await expect(editor).toContainText("Hello wiki");

  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect(editor).toContainText("Hello wiki and more");

  await page.screenshot({
    path: "test-results/responsive/19-mobile-wiki-typing.png",
  });
});

test("every wiki toolbar control stays reachable at 390px", async ({
  page,
}) => {
  // Regression: the fixed toolbar row clipped "Source" off the card, so that
  // mode could not be clicked at all.
  await openCommunity(page);
  await page.getByTestId("open-channel-list").click();
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("wiki-new-page").click();
  await page.getByTestId("page-name-input").fill("release-notes");
  await page.getByTestId("page-name-confirm").click();

  await expectNoClippedControls(page, "[data-testid='wiki-toolbar']");
  await expectNoOverflow(page, "wiki toolbar");
  await shot(page, "20-mobile-wiki-toolbar");
});

test("wiki pages can be created, renamed and deleted", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCommunity(page);
  await page.getByTestId("wiki-toggle").click();

  // Create through the dialog (was a blocking `window.prompt`).
  await page.getByTestId("wiki-new-page").click();
  await expect(page.getByTestId("page-name-hint")).toContainText(
    "at least one letter",
  );
  await page.getByTestId("page-name-input").fill("Release Notes");
  await expect(page.getByTestId("page-name-hint")).toContainText(
    "release-notes",
  );
  await page.getByTestId("page-name-confirm").click();
  await expect(page.getByTestId("wiki-page-release-notes")).toBeVisible();

  // Rename: the old slug goes away, the new one appears.
  await page.getByTestId("wiki-rename").click();
  await page.getByTestId("page-name-input").fill("changelog");
  await page.getByTestId("page-name-confirm").click();
  await expect(page.getByTestId("wiki-page-changelog")).toBeVisible();
  await expect(page.getByTestId("wiki-page-release-notes")).toBeHidden();

  // Delete asks first, then hides the page.
  await page.getByTestId("wiki-delete").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("wiki-page-changelog")).toBeHidden();
});

test("invite landing fits", async ({ page }) => {
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: {
          terms_markdown: "# Terms",
          privacy_markdown: "# Privacy",
          age_attestation_required: true,
          version: "policy-v1",
        },
      }),
    });
  });
  // Offline for the release lookup: the page must still lay out its fallback.
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({ status: 503, body: "unavailable" });
  });
  await page.goto("/invite/demo-code");
  await expect(
    page.getByRole("button", { name: "Accept invite in Creaton" }),
  ).toBeVisible();
  await expectNoOverflow(page, "invite");
  await expectNoClippedControls(page, "main");
  await shot(page, "21-mobile-invite");
});

test("repository browser fits", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/repos");
  await expect(
    page.getByRole("heading", { name: "This community is empty" }),
  ).toBeVisible();
  await expectNoOverflow(page, "repos");
  await shot(page, "22-mobile-repos");
});

test("launchpad detail fits", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/launchpad");
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await expectNoOverflow(page, "launchpad detail");
  await expectNoClippedControls(page, "main");
  await shot(page, "23-mobile-launchpad-detail");
});

test("an unavailable chain read reports no amount", async ({ page }) => {
  await mockRelay(page);
  await page.goto("/launchpad/nebula");
  await expect(page.getByTestId("launch-progress-source")).toHaveText(
    "No chain data",
  );
  // "0 / —" would read as a funded state of zero, not an unknown one.
  await expect(page.getByText("Raised").locator("..")).not.toContainText("0 /");
});
