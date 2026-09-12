import { createHash } from "node:crypto";
import { getPublicKey } from "nostr-tools/pure";
import { expect, test } from "@playwright/test";

test("home page loads with Creaton branding", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("main").getByRole("img", { name: "Creaton" }),
  ).toBeVisible();
});

const directoryFixture = {
  communities: [
    {
      host: "alpha.example.com",
      name: "Alpha",
      description: "A test community.",
      icon: null,
      member_count: 3,
      archived: false,
    },
    {
      host: "beta.example.com",
      name: "Beta",
      description: "Another one.",
      member_count: 11,
      archived: false,
    },
    {
      host: "retired.example.com",
      name: "Retired",
      description: "No longer served.",
      member_count: 4,
      archived: true,
    },
  ],
};

async function mockCommunityDirectory(page: import("@playwright/test").Page) {
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(directoryFixture),
    });
  });
}

test("home page shows the community directory from the relay", async ({
  page,
}) => {
  await mockCommunityDirectory(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Communities" }),
  ).toBeVisible();
  await expect(page.getByText("alpha.example.com")).toBeVisible();
  await expect(page.getByText("11 members")).toBeVisible();
  // An archived community is distinguishable: clicking it will not work, and
  // saying so beats a card that looks like the others.
  await expect(
    page.getByTestId("community-archived-retired.example.com"),
  ).toBeVisible();
});

test("empty directory shows the discovery empty state", async ({ page }) => {
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ communities: [] }),
    });
  });
  await page.goto("/");
  await expect(
    page.getByText("No communities on this relay yet"),
  ).toBeVisible();
});

test("home page falls back when the directory endpoint is missing", async ({
  page,
}) => {
  // Older relays without GET /communities: the landing degrades to the repo
  // browser, which surfaces its own connection error state.
  await page.route("**/communities", async (route) => {
    await route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Couldn't reach the relay" }),
  ).toBeVisible();
});

test("community page shows metadata and join stores the relay URL", async ({
  page,
}) => {
  await mockCommunityDirectory(page);
  // An empty relay: the community exists but publishes no channels, so the
  // public card is the correct state (a failed query is an error state).
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (Array.isArray(parsed) && parsed[0] === "REQ") {
        ws.send(JSON.stringify(["EOSE", parsed[1]]));
      }
    });
  });
  await page.goto("/c/alpha.example.com");
  await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  await expect(page.getByText("3 members")).toBeVisible();
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz.relayUrl")),
    )
    .toBe("ws://alpha.example.com");
});

test("invite requires age and legal consent before opening Creaton", async ({
  page,
}) => {
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
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify([
        { draft: false, prerelease: false, assets: [] },
        {
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "Buzz_0.4.9_aarch64.dmg",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_aarch64.dmg",
            },
            {
              name: "Buzz_0.4.9_x64.dmg",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64.dmg",
            },
            {
              name: "Buzz_0.4.9_amd64.AppImage",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_amd64.AppImage",
            },
            {
              name: "Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
            },
          ],
        },
      ]),
    });
  });
  await page.goto("/invite/demo-code");

  await expect(
    page.getByRole("link", { name: "Download it now" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
  );

  const ageConfirmation = page.getByLabel("I am 18 years of age or older.");
  const agreementConfirmation = page.getByLabel(
    "I agree to the Creaton Terms of Service and Privacy Policy.",
  );
  const acceptInvite = page.getByRole("button", {
    name: "Accept invite in Creaton",
  });

  await expect(ageConfirmation).toBeVisible();
  await expect(agreementConfirmation).toBeVisible();
  await expect(acceptInvite).toBeDisabled();

  const termsLink = page.getByRole("button", { name: "Terms of Service" });
  const privacyLink = page.getByRole("button", { name: "Privacy Policy" });
  await expect(termsLink).toHaveCSS("text-decoration-line", "none");
  await expect(privacyLink).toHaveCSS("text-decoration-line", "none");
  await termsLink.hover();
  await expect(termsLink).toHaveCSS("text-decoration-line", "underline");
  await page.mouse.move(0, 0);
  await privacyLink.hover();
  await expect(privacyLink).toHaveCSS("text-decoration-line", "underline");

  await page
    .locator("label")
    .filter({ hasText: "I am 18 years of age or older." })
    .click();
  await expect(ageConfirmation).toBeChecked();
  await expect(acceptInvite).toBeDisabled();
  await page
    .locator("label")
    .filter({
      hasText: "I agree to the Creaton Terms of Service and Privacy Policy.",
    })
    .click({ position: { x: 8, y: 8 } });
  await expect(agreementConfirmation).toBeChecked();
  await expect(acceptInvite).toBeEnabled();

  const consentBox = await page
    .getByTestId("invite-join-policy-notice")
    .boundingBox();
  const acceptButtonBox = await acceptInvite.boundingBox();
  expect(consentBox?.y).toBeLessThan(acceptButtonBox?.y ?? 0);
  expect(consentBox?.width).toBe(acceptButtonBox?.width);
});

test("invite can enroll a NIP-07 identity for browser access", async ({
  page,
}) => {
  const pubkey = "ab".repeat(32);
  await page.addInitScript((extensionPubkey) => {
    (
      window as Window & {
        nostr?: {
          getPublicKey(): Promise<string>;
          signEvent(
            event: Record<string, unknown>,
          ): Promise<Record<string, unknown>>;
        };
      }
    ).nostr = {
      async getPublicKey() {
        return extensionPubkey;
      },
      async signEvent(event) {
        return {
          ...event,
          id: "cd".repeat(32),
          pubkey: extensionPubkey,
          sig: "ef".repeat(64),
        };
      },
    };
  }, pubkey);
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });

  let claimObserved = false;
  await page.route("**/api/invites/claim", async (route) => {
    claimObserved = true;
    const request = route.request();
    const body = request.postData() ?? "";
    expect(JSON.parse(body)).toEqual({
      code: "browser-code",
    });

    const authorization = request.headers().authorization;
    expect(authorization).toMatch(/^Nostr /);
    const event = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString(
        "utf8",
      ),
    ) as {
      pubkey: string;
      tags: string[][];
    };
    expect(event.pubkey).toBe(pubkey);
    expect(event.tags).toContainEqual(["u", request.url()]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual([
      "payload",
      createHash("sha256").update(body).digest("hex"),
    ]);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "joined",
        community_id: "community-id",
        host: "127.0.0.1",
        role: "member",
      }),
    });
  });

  await page.goto("/invite/browser-code");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");
  expect(claimObserved).toBe(true);
});

test("invite asks Safari users to choose their Mac download", async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.5 Safari/605.1.15",
  });
  await context.addInitScript(() => {
    Object.defineProperties(navigator, {
      platform: { configurable: true, value: "MacIntel" },
      maxTouchPoints: { configurable: true, value: 0 },
      userAgentData: { configurable: true, value: undefined },
    });
  });
  const page = await context.newPage();
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({ status: 500 });
  });

  await page.goto("/invite/demo-code");
  const download = page.getByRole("link", { name: "Download it now" });
  await expect(download).toHaveAttribute("aria-haspopup", "dialog");
  await download.click();

  const chooser = page.getByRole("dialog", {
    name: "Which Mac do you have?",
  });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("link", { name: /Newer Mac/ })).toContainText(
    "2021 or later, or a late-2020 Mac with an Apple M1 chip",
  );
  await expect(chooser.getByRole("link", { name: /Older Mac/ })).toContainText(
    "2019 or earlier, or a 2020 Mac with an Intel processor",
  );
  await expect(chooser.getByText("About This Mac")).toBeVisible();

  const openedPagePromise = context.waitForEvent("page");
  await chooser.getByRole("link", { name: /Newer Mac/ }).click();
  const openedPage = await openedPagePromise;
  await expect(chooser).toBeHidden();
  await expect(openedPage).toHaveURL("https://github.com/block/buzz/releases");
  await expect(page).toHaveURL(/\/invite\/demo-code$/);
  await openedPage.close();

  await download.click();
  await expect(chooser).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();
  await expect(download).toBeFocused();
  await context.close();
});

test("invite download falls back for mobile and non-desktop devices", async ({
  browser,
}) => {
  const unsupportedDevices = [
    {
      name: "iPhone Safari",
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "iPadOS desktop mode",
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "Android phone",
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Mobile",
      maxTouchPoints: 5,
    },
    {
      name: "ChromeOS",
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36",
      maxTouchPoints: 0,
    },
  ];

  for (const device of unsupportedDevices) {
    const context = await browser.newContext({ userAgent: device.userAgent });
    await context.addInitScript(({ platform, maxTouchPoints }) => {
      Object.defineProperties(navigator, {
        platform: { configurable: true, value: platform },
        maxTouchPoints: { configurable: true, value: maxTouchPoints },
        userAgentData: {
          configurable: true,
          value: { platform, mobile: maxTouchPoints > 0 },
        },
      });
    }, device);
    const page = await context.newPage();
    await page.route("**/api/join-policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ policy: null }),
      });
    });
    await page.route("https://api.github.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify([
          {
            draft: false,
            prerelease: false,
            assets: [
              {
                name: "Buzz_0.4.9_x64.dmg",
                browser_download_url:
                  "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64.dmg",
              },
              {
                name: "Buzz_0.4.9_amd64.AppImage",
                browser_download_url:
                  "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_amd64.AppImage",
              },
            ],
          },
        ]),
      });
    });

    await page.goto("/invite/demo-code");
    await expect(
      page.getByRole("link", { name: "Download it now" }),
      device.name,
    ).toHaveAttribute("href", "https://github.com/block/buzz/releases");
    await context.close();
  }
});

test("wrong relay shows connect form and stores the relay URL", async ({
  page,
}) => {
  // Served from a non-relay origin (vite preview / static host), the app
  // cannot reach a WebSocket endpoint and must surface the connect form
  // instead of silently rendering the empty-community icon screen.
  await page.goto("/");
  // Clear once up front; addInitScript would re-clear on the reload that
  // Connect triggers and race the write.
  await page.evaluate(() => window.localStorage.removeItem("buzz.relayUrl"));
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Couldn't reach the relay" }),
  ).toBeVisible();
  await page.getByLabel("Relay URL").fill("wss://relay.example.com");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz.relayUrl")),
    )
    .toBe("wss://relay.example.com");
});

test("the landing Repositories button opens the repo browser", async ({
  page,
}) => {
  // Regression: /repos was a redirect back to `/`, so this button did nothing.
  await mockCommunityDirectory(page);
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[0] !== "REQ") return;
      ws.send(JSON.stringify(["EOSE", parsed[1]]));
    });
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Repositories" }).click();
  await expect(page).toHaveURL(/\/repos$/);
  await expect(
    page.getByRole("heading", { name: "This community is empty" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Communities" })).toBeHidden();
});

test("a channel query failure offers a retry instead of an empty community", async ({
  page,
}) => {
  // No WebSocket mock: the channel query fails. The page must say so and allow
  // a retry rather than presenting the join-an-empty-community card.
  await mockCommunityDirectory(page);
  await page.goto("/c/alpha.example.com");
  const panel = page.getByTestId("community-load-error");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("alpha.example.com");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Join in browser" }),
  ).toBeHidden();
});

test("a malformed relay payload shows a recoverable error, not a blank page", async ({
  page,
}) => {
  // Production relays can answer with an unexpected shape. Before the route
  // error boundary existed this threw during render and left a blank window.
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ communities: "not-an-array" }),
    });
  });
  await page.goto("/");
  const boundary = page.getByTestId("route-error");
  await expect(boundary).toBeVisible();
  await expect(boundary).toContainText("Something went wrong");
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("an unknown address shows the not-found view", async ({ page }) => {
  await page.goto("/definitely/not/a/route");
  await expect(page.getByTestId("route-not-found")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "All communities" }),
  ).toBeVisible();
});

/** Relay mock where only the channel query succeeds; everything else is refused. */
async function mockPartialRelay(page: import("@playwright/test").Page) {
  await mockCommunityDirectory(page);
  const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
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
      if ((filter.kinds ?? []).includes(39000)) {
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
        ws.send(JSON.stringify(["EOSE", subId]));
        return;
      }
      // What a rejected filter looks like on the wire.
      ws.send(
        JSON.stringify(["CLOSED", subId, "blocked: relay does not serve that"]),
      );
    });
  });
}

test("the work board reports a refused query instead of an empty board", async ({
  page,
}) => {
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("work-toggle").click();
  const panel = page.getByTestId("work-load-error");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("blocked: relay does not serve that");
  await expect(page.getByTestId("work-load-error-retry")).toBeVisible();
  await expect(page.getByText("0 items")).toBeHidden();
});

test("the fleet view reports a refused roster query", async ({ page }) => {
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("fleet-toggle").click();
  await expect(page.getByTestId("fleet-load-error")).toBeVisible();
});

test("the launchpad directory reports a refused query and offers a retry", async ({
  page,
}) => {
  await mockPartialRelay(page);
  await page.goto("/launchpad");
  const panel = page.getByTestId("launchpad-load-error");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("launchpad-load-error-retry")).toBeVisible();
  await expect(page.getByText("No launches yet")).toBeHidden();
});

test("the work board degrades to a notice when only secondary reads fail", async ({
  page,
}) => {
  // Tasks and issues load; status history does not. The board must still show
  // the items and say what is missing, rather than blanking or hiding it.
  await mockCommunityDirectory(page);
  await page.route("**/query", async (route) => {
    await route.fulfill({ status: 500, body: "no status index" });
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
      const kinds = filter.kinds ?? [];
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
                ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
                ["name", "general"],
              ],
              content: "",
              sig: "sig",
            },
          ]),
        );
      } else if (kinds.includes(44011)) {
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: "task-1",
              pubkey: "b".repeat(64),
              created_at: 200,
              kind: 44011,
              tags: [
                ["d", "task-1"],
                ["title", "Ship the release"],
                ["status", "open"],
              ],
              content: JSON.stringify({ title: "Ship the release" }),
              sig: "sig",
            },
          ]),
        );
      }
      // Status and approval filters are refused.
      if (
        kinds.includes(1630) ||
        kinds.includes(1631) ||
        kinds.includes(1632) ||
        kinds.includes(46030)
      ) {
        ws.send(JSON.stringify(["CLOSED", subId, "blocked: no status index"]));
        return;
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("work-toggle").click();

  await expect(page.getByTestId("work-degraded")).toBeVisible();
  await expect(page.getByTestId("work-load-error")).toBeHidden();
  // The title appears in the card and in the detail pane; either proves the item
  // survived while only secondary reads failed.
  await expect(page.getByText("Ship the release").first()).toBeVisible();
});

test("a wiki page saves, reports success and stops showing a draft badge", async ({
  page,
}) => {
  // End-to-end save path: publish, toast, badge. The cache-optional behaviour
  // is unit-tested in `features/wiki/lib/cache.test.mjs`; stubbing browser
  // storage here did not actually reach that code path, so this test does not
  // claim to cover it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockCommunityDirectory(page);
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT" || parsed[0] === "AUTH") {
        // Accept every publish so the test exercises the save path.
        ws.send(JSON.stringify(["OK", parsed[1].id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      if ((filter.kinds ?? []).includes(39000)) {
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
                ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
                ["name", "general"],
              ],
              content: "",
              sig: "sig",
            },
          ]),
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("wiki-toggle").click();

  await page.getByTestId("wiki-new-page").click();
  await page.getByTestId("page-name-input").fill("offline-page");
  await page.getByTestId("page-name-confirm").click();

  const editor = page.getByTestId("wiki-wysiwyg").locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("Saved without a cache");

  const save = page.getByTestId("wiki-save");
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByText("Page saved")).toBeVisible();
  await expect(page.getByTestId("wiki-save-state")).toHaveText("saved");
  await expect(page.getByText("Couldn't save page")).toBeHidden();
});

test("Cmd+K focuses search, opening the slide-over on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();

  const input = page.getByTestId("search-input");
  await page.keyboard.press("Meta+k");

  await expect(input).toBeFocused();
  // The sidebar it lives in must slide on screen for that focus to be usable.
  await expect
    .poll(
      async () =>
        (await page.locator("#channel-sidebar").boundingBox())?.x ?? -1,
    )
    .toBeGreaterThanOrEqual(0);
});

test("the search shortcut hint is visible on desktop and hidden on a phone", async ({
  page,
}) => {
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByText("⌘K")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("⌘K")).toBeHidden();
});

test("a bound wallet can be unbound, and the proof names the revoke endpoint", async ({
  page,
}) => {
  const address = `0x${"ab".repeat(20)}`;
  await page.addInitScript(
    ([addr]) => {
      window.localStorage.setItem("buzz.identity.nsec", "1".repeat(64));
      window.localStorage.setItem(
        "buzz.siwe.binding",
        JSON.stringify({ address: addr, pubkey: "b".repeat(64), boundAt: 1 }),
      );
    },
    [address],
  );
  const bodies: unknown[] = [];
  await page.route("**/auth/siwe/revoke", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();

  await page.getByTestId("user-chip").click();
  await expect(page.getByTestId("wallet-binding")).toContainText("0xabab…abab");

  await page.getByRole("button", { name: "Unbind wallet" }).click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-accept").click();

  await expect(page.getByTestId("wallet-binding")).toBeHidden();
  expect(bodies).toHaveLength(1);
  const proof = (
    bodies[0] as {
      nostr_proof: { kind: number; content: string; tags: string[][] };
    }
  ).nostr_proof;
  expect(proof.kind).toBe(27235);
  expect(proof.content).toBe(address);
  expect(proof.tags).toContainEqual(["u", "/auth/siwe/revoke"]);
});

test("a refused task write says so instead of failing silently", async ({
  page,
}) => {
  // The board used to swallow these: a quick-add or a column move the relay
  // refused left the user looking at an unchanged board.
  await mockCommunityDirectory(page);
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        ws.send(
          JSON.stringify(["OK", parsed[1].id, false, "blocked: writer denied"]),
        );
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      if ((filter.kinds ?? []).includes(39000)) {
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
                ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
                ["name", "general"],
              ],
              content: "",
              sig: "sig",
            },
          ]),
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("work-toggle").click();

  await page.getByTestId("kanban-add-open").click();
  await page.getByTestId("kanban-quick-input").fill("Silent failure");
  // Scope to the quick-add row: every column header also has an "Add" button.
  await page
    .getByTestId("kanban-quick-input")
    .locator("xpath=following-sibling::button[1]")
    .click();

  await expect(page.getByText("Couldn't create the task")).toBeVisible();
  await expect(
    page.getByText("blocked: writer denied", { exact: false }),
  ).toBeVisible();
});

test("heavy views are split out of the first-load bundle", async ({ page }) => {
  // Measured at build time by the recipe in `scripts/`? No: assert the runtime
  // consequence — opening a community must not fetch the wiki/fleet/index
  // chunks, which is what keeps first load small.
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();

  const loaded = scripts.join(" ");
  expect(loaded).not.toContain("WikiView-");
  expect(loaded).not.toContain("WorkBoard-");
  expect(loaded).not.toContain("FleetView-");

  // …and the wiki chunk arrives when the panel is opened.
  await page.getByTestId("wiki-toggle").click();
  await expect(page.getByTestId("wiki-page-list")).toBeVisible();
  expect(scripts.join(" ")).toContain("WikiView-");
});

test("a message can be copied, and its link opens and highlights it", async ({
  page,
  context,
  browserName,
}) => {
  void browserName;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockCommunityDirectory(page);
  const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
  const MESSAGE_ID = "e".repeat(64);
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
      const kinds = filter.kinds ?? [];
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
      if (kinds.includes(9)) {
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: MESSAGE_ID,
              pubkey: "b".repeat(64),
              created_at: 200,
              kind: 9,
              tags: [["h", CHANNEL_ID]],
              content: "Copyable message body",
              sig: "sig",
            },
          ]),
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByText("Copyable message body")).toBeVisible();

  const row = page.getByTestId("message-row").first();
  await row.hover();
  await row.getByTestId("copy-message").click();
  await expect(page.getByText("Message copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Copyable message body",
  );

  await row.hover();
  await row.getByTestId("copy-message-link").click();
  await expect(page.getByText("Link copied")).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain(`message=${MESSAGE_ID}`);
  expect(link).toContain(`channel=${CHANNEL_ID}`);

  // The link must actually work: open it and the row is anchored and marked.
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(page.getByText("Copyable message body")).toBeVisible();
  await expect(page.locator(`#message-${MESSAGE_ID}`)).toHaveAttribute(
    "data-highlighted",
    "true",
  );
});

test("the tab agent's key can be rotated and its storage is disclosed", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("buzz.agent.nsec", "ab".repeat(32));
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockCommunityDirectory(page);
  // A permissive relay: the roster must load, or the fleet view shows its
  // error panel instead (which is what `mockPartialRelay` would produce).
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
      if ((filter.kinds ?? []).includes(39000)) {
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
                ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
                ["name", "general"],
              ],
              content: "",
              sig: "sig",
            },
          ]),
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("fleet-toggle").click();

  // Agent stopped: the disclosure explains the key it will create on start.
  await expect(page.getByTestId("agent-key-disclosure")).toContainText(
    "creates a signing key for it in this browser",
  );

  await page.getByTestId("reset-agent-key").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-accept").click();

  await expect(page.getByText("Agent key reset")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz.agent.nsec")),
    )
    .toBeNull();
});

test("the wiki page dialog takes focus and gives it back", async ({ page }) => {
  // A UX guard, not a proof of the focus trap: this Chromium already contains
  // tab focus for `role="dialog" aria-modal="true"`, so the trap's wrap cannot
  // be observed here (verified by removing it and re-running). The trap still
  // makes focus-on-open and restore explicit rather than incidental on engines
  // that do not contain focus (Safari, webviews).
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("wiki-toggle").click();

  const opener = page.getByTestId("wiki-new-page");
  await opener.click();
  const input = page.getByTestId("page-name-input");
  await expect(input).toBeFocused();

  // Tab still keeps the user inside the dialog.
  await page.keyboard.press("Tab");
  const inside = await page.evaluate(() =>
    Boolean(document.activeElement?.closest("form[role='dialog']")),
  );
  expect(inside).toBe(true);

  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
  await expect(opener).toBeFocused();
});

test("a refused search offers a retry", async ({ page }) => {
  await mockCommunityDirectory(page);
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
      const kinds = filter.kinds ?? [];
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
                ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
                ["name", "general"],
              ],
              content: "",
              sig: "sig",
            },
          ]),
        );
        ws.send(JSON.stringify(["EOSE", subId]));
        return;
      }
      ws.send(JSON.stringify(["CLOSED", subId, "blocked: no search index"]));
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("search-input").fill("release notes");

  // Search runs over the HTTP bridge; against a static preview host that call
  // fails, which is exactly the state this panel exists for.
  const panel = page.getByTestId("search-error");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Search failed");
  await expect(page.getByTestId("search-error-retry")).toBeVisible();
});

test.describe("document shell", () => {
  test.use({ colorScheme: "dark" });

  test("the theme is applied before the app bundle runs", async ({ page }) => {
    // Abort the bundle: whatever sets the theme must be independent of it, or
    // dark-mode users see a white flash while React boots.
    await page.route(/\/assets\/index-.*\.js$/, (route) => route.abort());
    await page.goto("/");
    const classes = await page.evaluate(
      () => document.documentElement.className,
    );
    expect(classes).toContain("dark");
  });

  test("the document carries a content security policy", async ({ page }) => {
    await page.goto("/");
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("script-src 'self'");
    // No script from another origin may run, which is the point of the policy.
    expect(policy).not.toContain("script-src 'unsafe-inline'");
  });
});

test("a dropped live connection is shown instead of failing silently", async ({
  page,
}) => {
  // The timeline used to stop updating with no indication at all when the relay
  // dropped the live socket.
  await mockCommunityDirectory(page);
  const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
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
      const kinds = filter.kinds ?? [];
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
      ws.send(JSON.stringify(["EOSE", subId]));
      // The live timeline subscription is the one carrying message kinds.
      if (kinds.includes(9)) ws.close();
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  const chip = page.getByTestId("live-status-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/Reconnecting|Connecting/);
});

test.describe("theme choice", () => {
  test("an explicit theme wins over the system preference and survives reload", async ({
    page,
  }) => {
    // Light system preference, dark chosen in the app.
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      window.localStorage.setItem("buzz.identity.nsec", "1".repeat(64));
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockPartialRelay(page);
    await page.goto("/c/alpha.example.com");
    await page.getByTestId("content-pane").waitFor();
    await page.getByTestId("user-chip").click();

    await page.getByTestId("theme-dark").click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.className))
      .toContain("dark");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("buzz.theme")))
      .toBe("dark");

    // Reload: the stored choice must still win over the light system theme.
    await page.reload();
    await page.getByTestId("content-pane").waitFor();
    const classes = await page.evaluate(
      () => document.documentElement.className,
    );
    expect(classes).toContain("dark");
  });

  test("a stored theme is painted before the app bundle runs", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(() => {
      window.localStorage.setItem("buzz.theme", "dark");
    });
    // Abort the bundle: only the boot script may set the class.
    await page.route(/\/assets\/index-.*\.js$/, (route) => route.abort());
    await page.goto("/");
    const classes = await page.evaluate(
      () => document.documentElement.className,
    );
    expect(classes).toContain("dark");
  });
});

test.describe("keyboard and motion preferences", () => {
  test("a focused control is visibly outlined", async ({ page }) => {
    // WCAG 2.4.7: axe does not check focus visibility, and only a handful of
    // components drew their own ring.
    await mockPartialRelay(page);
    await page.goto("/c/alpha.example.com");
    await page.getByTestId("content-pane").waitFor();
    await page.keyboard.press("Tab");

    const style = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const computed = getComputedStyle(el);
      return {
        tag: el.tagName,
        style: computed.outlineStyle,
        width: Number.parseFloat(computed.outlineWidth),
      };
    });
    expect(style).not.toBeNull();
    expect(style?.style).not.toBe("none");
    expect(style?.width ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("reduced motion collapses the client's animations", async ({ page }) => {
    // The animated slide-over only exists below `lg`.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockPartialRelay(page);
    await page.goto("/c/alpha.example.com");
    await page.getByTestId("content-pane").waitFor();
    await page.getByTestId("open-channel-list").click();

    const durations = await page.evaluate(() => {
      const panel = document.querySelector("#channel-sidebar");
      if (!panel) return null;
      const computed = getComputedStyle(panel);
      return {
        transition: computed.transitionDuration,
        scrollBehavior: getComputedStyle(document.documentElement)
          .scrollBehavior,
      };
    });
    expect(durations).not.toBeNull();
    // 0.01ms is the collapsed duration; anything larger means it still animates.
    expect(Number.parseFloat(durations?.transition ?? "1")).toBeLessThan(0.1);
  });
});

test("the wiki says when nobody else is connected", async ({ page }) => {
  // Live co-editing needs the relay to accept P2P signalling. On a relay that
  // does not, the honest state is "editing alone" with the reason in the title,
  // rather than a silent no-op that looks like a broken feature.
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockPartialRelay(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("wiki-new-page").click();
  await page.getByTestId("page-name-input").fill("solo-page");
  await page.getByTestId("page-name-confirm").click();

  const editors = page.getByTestId("wiki-editors");
  await expect(editors).toBeVisible();
  await expect(editors).toContainText("Editing alone");
  await expect(editors).toHaveAttribute("title", /P2P signalling/);
});

test("two tabs converge on one page without P2P signalling", async ({
  context,
  page,
}) => {
  // The snapshot path is the only cross-tab mechanism on a relay without P2P
  // signalling. A tab that had typed used to ignore every snapshot, so an
  // active editor never saw a collaborator's saved work.
  await page.setViewportSize({ width: 1280, height: 900 });
  const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
  const SLUG = "release-notes";
  /** Shared relay store: published wiki pages, replayed to every REQ. */
  let stored: {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  } | null = null;

  const installRelay = async (target: import("@playwright/test").Page) => {
    await target.route("**/communities", async (route) => {
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
              member_count: 1,
              archived: false,
            },
          ],
        }),
      });
    });
    await target.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
      ws.onMessage((message) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message));
        } catch {
          return;
        }
        if (!Array.isArray(parsed)) return;
        if (parsed[0] === "EVENT" || parsed[0] === "AUTH") {
          const event = parsed[1];
          if (parsed[0] === "EVENT" && event?.kind === 44001) {
            stored = event;
          }
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          return;
        }
        if (parsed[0] !== "REQ") return;
        const [, subId, filter] = parsed as [
          string,
          string,
          { kinds?: number[] },
        ];
        const kinds = filter.kinds ?? [];
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
        if (kinds.includes(44001) && stored) {
          ws.send(JSON.stringify(["EVENT", subId, stored]));
        }
        ws.send(JSON.stringify(["EOSE", subId]));
      });
    });
  };

  await installRelay(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("wiki-new-page").click();
  await page.getByTestId("page-name-input").fill(SLUG);
  await page.getByTestId("page-name-confirm").click();
  const editor = page.getByTestId("wiki-wysiwyg").locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("First author");
  await page.getByTestId("wiki-save").click();
  await expect(page.getByText("Page saved")).toBeVisible();

  // Second tab, same page, with its own unsaved edit.
  const second = await context.newPage();
  await second.setViewportSize({ width: 1280, height: 900 });
  await installRelay(second);
  await second.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await second.getByTestId("content-pane").waitFor();
  await second.getByTestId("wiki-toggle").click();
  await second.getByTestId(`wiki-page-${SLUG}`).click();
  const secondEditor = second
    .getByTestId("wiki-wysiwyg")
    .locator(".ProseMirror");
  await expect(secondEditor).toContainText("First author");
  await secondEditor.click();
  await second.keyboard.press("End");
  await second.keyboard.type(" plus second");

  // The first tab saves again; the second must keep its own text and gain the
  // other author's, which is what the delta merge is for.
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (edited)");
  await page.getByTestId("wiki-save").click();

  // The second tab must be foregrounded: Chromium throttles background timers,
  // which would stall its poll (in production the other editor is another tab
  // on another machine, not throttled).
  await second.bringToFront();
  await expect(secondEditor).toContainText("(edited)", { timeout: 15_000 });
  await expect(secondEditor).toContainText("plus second");
  await second.close();
});

test("a refused task query is reported on the agents view", async ({
  page,
}) => {
  // The fleet task list turned a failed read into "no tasks". The roster must
  // load so the view renders, while the task query is refused.
  await mockCommunityDirectory(page);
  const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
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
      const kinds = filter.kinds ?? [];
      if (kinds.includes(44011)) {
        ws.send(JSON.stringify(["CLOSED", subId, "blocked: no task index"]));
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
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("fleet-toggle").click();

  const panel = page.getByTestId("fleet-tasks-load-error");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("blocked: no task index");
});

test("a launch can be bound to a discussion channel", async ({ page }) => {
  // The wizard always published an empty `buzz-channel` list, so the record's
  // community link could never be set from the web client.
  const published: Array<{ kind: number; tags: string[][] }> = [];
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ communities: [] }),
    });
  });
  const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        published.push(parsed[1]);
        ws.send(JSON.stringify(["OK", parsed[1].id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      if ((filter.kinds ?? []).includes(39000)) {
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
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/launchpad");
  await page
    .getByRole("button", { name: /New launch/ })
    .first()
    .click();
  await page.getByLabel("Launch id").fill("channel-bound");
  await page.getByLabel("Name", { exact: true }).fill("Channel Bound DAO");

  await page.getByTestId("launch-channel-general").click();
  await expect(page.getByTestId("launch-channel-general")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const publish = page.getByRole("button", { name: "Publish launch" });
  // The token name and symbol derive from the launch name, so publishing does
  // not require filling the token section by hand.
  await expect(publish).toBeEnabled();
  await publish.scrollIntoViewIfNeeded();
  await publish.click();

  await expect
    .poll(() => published.filter((e) => e.kind === 37001).length)
    .toBeGreaterThan(0);
  const record = published.find((e) => e.kind === 37001);
  expect(record?.tags).toContainEqual(["buzz-channel", CHANNEL_ID]);
});

test("editing a name keeps the rest of the profile", async ({ page }) => {
  // Kind 0 is replaceable: publishing only the fields this screen edits used to
  // delete the avatar, NIP-05 handle and anything else set elsewhere.
  // The profile must be authored by the identity this tab derives from the
  // seeded nsec, not by the nsec string itself.
  const PUBKEY_IDENTITY = getPublicKey(
    Uint8Array.from(
      "1"
        .repeat(64)
        .match(/.{2}/g)!
        .map((b) => Number.parseInt(b, 16)),
    ),
  );
  const published: Array<{ kind: number; content: string }> = [];
  await page.addInitScript(() => {
    window.localStorage.setItem("buzz.identity.nsec", "1".repeat(64));
  });
  await mockCommunityDirectory(page);
  const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        published.push(parsed[1]);
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
      if (kinds.includes(0)) {
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: "profile-1",
              pubkey: PUBKEY_IDENTITY,
              created_at: 100,
              kind: 0,
              tags: [],
              content: JSON.stringify({
                name: "Old Name",
                picture: "https://example.com/avatar.png",
                nip05: "old@example.com",
                lud16: "old@walletofsatoshi.com",
              }),
              sig: "sig",
            },
          ]),
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("user-chip").click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByTestId("profile-name-input").fill("New Name");
  await page.getByTestId("profile-save").click();

  await expect
    .poll(() => published.filter((e) => e.kind === 0).length)
    .toBeGreaterThan(0);
  const profile = JSON.parse(
    published.filter((e) => e.kind === 0).at(-1)!.content,
  ) as Record<string, unknown>;
  expect(profile.name).toBe("New Name");
  expect(profile.display_name).toBe("New Name");
  expect(profile.picture).toBe("https://example.com/avatar.png");
  expect(profile.nip05).toBe("old@example.com");
  expect(profile.lud16).toBe("old@walletofsatoshi.com");
});

test("invite can enroll the identity this app creates, without an extension", async ({
  page,
}) => {
  // The invite page used to offer "Join in browser" only when a NIP-07
  // extension was present, so a reader using the identity this app creates for
  // them had no way to join at all — the landing page was a dead end.
  const nsec = "dd".repeat(32);
  const pubkey = getPublicKey(
    Uint8Array.from(nsec.match(/.{2}/g) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    ),
  );
  await page.addInitScript(
    ([key]) => window.localStorage.setItem("buzz.identity.nsec", key),
    [nsec],
  );
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });

  let claimPubkey: string | null = null;
  await page.route("**/api/invites/claim", async (route) => {
    const request = route.request();
    const authorization = request.headers().authorization ?? "";
    const event = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString(
        "utf8",
      ),
    ) as { pubkey: string; tags: string[][] };
    claimPubkey = event.pubkey;
    // The body must be covered, exactly as the relay requires.
    expect(event.tags).toContainEqual([
      "payload",
      createHash("sha256")
        .update(request.postData() ?? "")
        .digest("hex"),
    ]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "joined",
        community_id: "community-id",
        host: "127.0.0.1",
        role: "member",
      }),
    });
  });

  await page.goto("/invite/durable-code");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");
  expect(claimPubkey, "the claim is signed by this browser's identity").toBe(
    pubkey,
  );
});
