import { expect, test, type Page } from "@playwright/test";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * `/c/<host>` for a community on another server (Review B 3). The page used to open the shell whenever the CONNECTED
 * server had rooms, so `/c/<another host>` showed this server's rooms under the other community's name, and nothing on
 * screen said the person was still talking to the first server. Another host is another community: its own card, and
 * joining it switches this browser to its server.
 */

const OTHER_HOST = "beta.example.com";
const SERVER = "9".repeat(64);
const HERE_ROOM = "0f0f0f0f-1111-2222-3333-444444444444";
const OTHER_ROOM = "0f0f0f0f-1111-2222-3333-777777777777";

function room(id: string, name: string) {
  return {
    id: `meta-${name}`,
    pubkey: SERVER,
    kind: 39000,
    created_at: 100,
    tags: [
      ["d", id],
      ["name", name],
    ],
    content: "",
    sig: "sig",
  };
}

/** The connected server (the preview's own address) has a room; the other community's server has one of its own. */
async function twoServers(page: Page) {
  const here = createMockRelay();
  here.seed(room(HERE_ROOM, "here-lobby"));
  await here.install(page);
  // The other server answers only its own room list, which is all its card and the switch need.
  await page.routeWebSocket(/beta\.example\.com/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[0] !== "REQ") return;
      const subId = parsed[1];
      const filters = parsed.slice(2) as { kinds?: number[] }[];
      if (filters.some((filter) => filter.kinds?.includes(39000))) {
        ws.send(
          JSON.stringify(["EVENT", subId, room(OTHER_ROOM, "beta-lounge")]),
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  // The connected server's public directory lists the other community.
  await page.route("**/communities", (route) =>
    route.fulfill({
      json: {
        communities: [
          {
            host: OTHER_HOST,
            name: "Beta Garden",
            description: "Where the beta crew meets.",
            icon: null,
            member_count: 7,
            archived: false,
          },
        ],
      },
    }),
  );
  return here;
}

/**
 * The connected server has been asked for its rooms and has answered: only then can a page that took them for this
 * community's have opened the shell, so only then does "none of its rooms is offered" say anything. The card shows
 * before the answer either way.
 */
async function connectedRoomsAnswered(
  page: Page,
  here: ReturnType<typeof createMockRelay>,
) {
  await expect.poll(() => here.requestsFor(39000)).toBeGreaterThan(0);
  // An absence can only be checked after the answer had time to render.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("channel-here-lobby")).toHaveCount(0);
  await expect(page.getByText("here-lobby")).toHaveCount(0);
}

test("from the connected community, another community opens as its own card", async ({
  page,
}) => {
  const here = await twoServers(page);
  // The connected server's rooms are loaded (and kept) first: a page that took them for any `/c/<host>` would now open
  // the shell for the other community at once.
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await expect(page.getByTestId("channel-here-lobby")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("app-nav-communities").click();
  await page.getByRole("link", { name: /Beta Garden/ }).click();
  await expect(page).toHaveURL(/\/c\/beta\.example\.com/);

  await expect(
    page.getByRole("heading", { name: "Beta Garden" }),
  ).toBeVisible();
  await expect(page.getByText("7 members")).toBeVisible();
  await expect(page.getByText("Where the beta crew meets.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Join this community" }),
  ).toBeVisible();
  await connectedRoomsAnswered(page, here);
  // Still this community's card once the connected server's rooms are in.
  await expect(
    page.getByRole("heading", { name: "Beta Garden" }),
  ).toBeVisible();
});

test("opening another community's address directly shows its card, and joining switches to its server", async ({
  page,
}) => {
  const here = await twoServers(page);
  await page.goto(`/c/${OTHER_HOST}`);

  await expect(page.getByRole("heading", { name: "Beta Garden" })).toBeVisible({
    timeout: 20_000,
  });
  const join = page.getByRole("button", { name: "Join this community" });
  await expect(join).toBeVisible();
  await connectedRoomsAnswered(page, here);
  await expect(join).toBeVisible();

  // Joining switches this browser to the other community's server, and its own rooms open.
  await join.click();
  await expect(page.getByTestId("channel-beta-lounge")).toBeVisible({
    timeout: 20_000,
  });
  expect(
    await page.evaluate(() => window.localStorage.getItem("buzz.relayUrl")),
  ).toBe(`ws://${OTHER_HOST}`);
  await expect(page.getByTestId("channel-here-lobby")).toHaveCount(0);
});
