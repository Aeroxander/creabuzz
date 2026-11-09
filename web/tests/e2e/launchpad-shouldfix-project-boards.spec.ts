import { expect, type Locator, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Boards belong to a project (owner decision): a project's page lists its own boards, the supporters and founders
 * boards are made inside the project and never loose on the server, and Home's Boards tab groups boards under their
 * project's name, with the server's own last.
 *
 * The tie is the project's record: it names the boards it owns (`buzz-channel` tags and its own board), which the server
 * keeps and every client reads. A board no record names is a server board and keeps working. The server is a mock that
 * keeps what it is sent, so what is checked is what the page writes (read back from the server) and what it shows.
 */

const NSEC = "7".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(NSEC, "hex")));
const OTHER = "c".repeat(64);
const id = (n: number) =>
  `0b0a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NEBULA_BOARD = id(1);
const NEBULA_SECOND = id(2);
const ORBIT_BOARD = id(3);
const LOOSE_BOARD = id(4);
const GENERAL = id(9);

let counter = 0;
const eid = () => (++counter).toString(16).padStart(64, "e");

function channel(boardId: string, name: string, type: "forum" | "stream") {
  return {
    id: eid(),
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", boardId], ["name", name], ["public"], ["t", type]],
    content: "",
    sig: "sig",
  };
}

function project(options: {
  id: string;
  name: string;
  author?: string;
  channels?: string[];
  board?: string;
  at?: number;
}) {
  return {
    id: eid(),
    pubkey: options.author ?? ME,
    created_at: options.at ?? 100,
    kind: 37001,
    tags: [
      ["d", options.id],
      ["name", options.name],
      ["t", "dao-launchpad"],
      ["admission", "community"],
      ...(options.channels ?? []).map((c) => ["buzz-channel", c]),
    ],
    content: JSON.stringify({
      pitch: "A thing worth making together.",
      stage: "draft",
      ...(options.board ? { chat: { board: options.board } } : {}),
    }),
    sig: "sig",
  };
}

type Relay = ReturnType<typeof createMockRelay>;

async function openAs(page: Page, relay: Relay, url: string, key = NSEC) {
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, key);
  await page.goto(url);
}

const field = (e: { tags: string[][] }, name: string) =>
  e.tags.find((t) => t[0] === name)?.[1];
const created = (relay: Relay) => relay.events.filter((e) => e.kind === 9007);
/** The newest record a founder published for a project: the one the server would keep. */
const newestRecord = (relay: Relay, projectId: string) =>
  relay.events
    .filter((e) => e.kind === 37001 && field(e, "d") === projectId)
    .sort((a, b) => b.created_at - a.created_at)[0];
const named = (record: { tags: string[][] }) =>
  record.tags.filter((t) => t[0] === "buzz-channel").map((t) => t[1]);

test("a project's page lists its own boards and nobody else's", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(channel(NEBULA_BOARD, "nebula-talk", "forum"));
  relay.seed(channel(NEBULA_SECOND, "nebula-ideas", "forum"));
  relay.seed(channel(ORBIT_BOARD, "orbit-talk", "forum"));
  relay.seed(channel(LOOSE_BOARD, "film-making", "forum"));
  relay.seed(
    project({
      id: "nebula",
      name: "Nebula",
      board: NEBULA_BOARD,
      channels: [NEBULA_BOARD, NEBULA_SECOND, GENERAL],
    }),
  );
  relay.seed(
    project({
      id: "orbit",
      name: "Orbit",
      author: OTHER,
      channels: [ORBIT_BOARD],
    }),
  );
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);

  const section = page.getByTestId("project-boards");
  await expect(section).toContainText("These belong to Nebula.");
  const list = page.getByTestId("project-boards-list");
  // Its own board first, then the other it names; not the chat room it names, not Orbit's, not the loose board.
  await expect(list.getByTestId("project-board-name")).toHaveText([
    "nebula-talk",
    "nebula-ideas",
  ]);
  await expect(section).not.toContainText("orbit-talk");
  await expect(section).not.toContainText("film-making");
  await list.getByTestId("project-board-name").first().click();
  await expect(page).toHaveURL(new RegExp(`/b/${NEBULA_BOARD}$`));
});

test("a founder's project without boards offers the supporters and founders pair, made inside the project", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(channel(LOOSE_BOARD, "film-making", "forum"));
  relay.seed(project({ id: "nebula", name: "Nebula" }));
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);

  await expect(page.getByTestId("project-boards-empty")).toHaveText(
    "This project has no boards yet.",
  );
  await page.getByTestId("project-boards-add").click();
  const names = page
    .getByTestId("project-boards-list")
    .getByTestId("project-board-name");
  await expect(names).toHaveText(["supporters", "founders"]);
  // Made, so the offer is gone.
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);

  const made = created(relay);
  expect(
    made.map((e) => [
      field(e, "name"),
      field(e, "visibility"),
      field(e, "channel_type"),
    ]),
  ).toEqual([
    ["supporters", "open", "forum"],
    ["founders", "private", "forum"],
  ]);
  // Each board opens with its first post.
  const posts = relay.events.filter((e) => e.kind === 45001);
  expect(posts.map((p) => p.tags[0][1])).toEqual(
    made.map((e) => field(e, "h")),
  );
  // The project's record names both, in one save; the loose board is not among them.
  const record = newestRecord(relay, "nebula");
  expect(named(record)).toEqual(made.map((e) => field(e, "h")));
  expect(named(record)).not.toContain(LOOSE_BOARD);

  // Read back from the server after a reload: the tie is not a thing this page remembered.
  await page.reload();
  await expect(names).toHaveText(["supporters", "founders"]);
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);
});

test("if the second board is refused the first stays in the project, the problem is said, and trying again makes only what is missing", async ({
  page,
}) => {
  let refuseFounders = true;
  const relay = createMockRelay({
    deriveChannels: true,
    refuse: (e) =>
      refuseFounders &&
      e.kind === 9007 &&
      e.tags.some((t) => t[0] === "name" && t[1] === "founders")
        ? "rate-limited: quota exceeded; retry in 20s"
        : null,
  });
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(project({ id: "nebula", name: "Nebula" }));
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);

  await page.getByTestId("project-boards-add").click();
  await expect(page.getByTestId("project-boards-problem")).toContainText(
    "You're doing that a bit fast. Try again in 20 seconds.",
  );
  const names = page
    .getByTestId("project-boards-list")
    .getByTestId("project-board-name");
  await expect(names).toHaveText(["supporters"]);

  refuseFounders = false;
  await page
    .getByTestId("project-boards-problem")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(names).toHaveText(["supporters", "founders"]);
  await expect(page.getByTestId("project-boards-problem")).toHaveCount(0);
  const count = (name: string) =>
    created(relay).filter((e) => field(e, "name") === name).length;
  expect([count("supporters"), count("founders")]).toEqual([1, 1]);
  expect(relay.events.filter((e) => e.kind === 45001)).toHaveLength(2);
  expect(named(newestRecord(relay, "nebula"))).toHaveLength(2);
});

test("someone who did not publish the project sees its boards but is not offered to make any", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(project({ id: "nebula", name: "Nebula", author: OTHER }));
  await openAs(page, relay, `/launchpad/nebula?author=${OTHER}&tab=boards`);

  await expect(page.getByTestId("project-boards-empty")).toContainText(
    "Its founder can add them.",
  );
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);
});

test("the workspace sidebar no longer offers a loose supporters and founders pair", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(channel(GENERAL, "general", "stream"));
  await openAs(page, relay, `/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByTestId("board-list")).toContainText(
    "A project's own boards are made on its page.",
  );
  await expect(page.getByTestId("starter-boards")).toHaveCount(0);
  await expect(page.getByTestId("new-board")).toBeVisible();
});

test("a board started from the sidebar can be put under one of your projects, or left as a server board", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(project({ id: "nebula", name: "Nebula" }));
  await openAs(page, relay, `/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();

  // Under the project.
  await page.getByTestId("new-board").click();
  await page.locator("#channel-name").fill("nebula-help");
  await page.locator("#channel-project").selectOption({ label: "Nebula" });
  await page.getByTestId("submit-create-channel").click();
  await expect(page.getByTestId("create-channel-dialog")).toHaveCount(0);
  const first = created(relay).find((e) => field(e, "name") === "nebula-help");
  expect(first).toBeTruthy();
  expect(named(newestRecord(relay, "nebula"))).toEqual([
    first ? field(first, "h") : undefined,
  ]);

  // Left as a server board: the record is not touched again.
  const saved = relay.events.filter((e) => e.kind === 37001).length;
  await page.getByTestId("new-board").click();
  await page.locator("#channel-name").fill("everyone-chat");
  await expect(page.locator("#channel-project")).toHaveValue("");
  await page.getByTestId("submit-create-channel").click();
  await expect(page.getByTestId("create-channel-dialog")).toHaveCount(0);
  await expect(page.getByTestId("board-nav-everyone-chat")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 37001)).toHaveLength(saved);
});

test("Home's Boards tab groups boards under their project, with the server's own last", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(channel(LOOSE_BOARD, "alpha-films", "forum"));
  relay.seed(channel(NEBULA_BOARD, "beta-nebula", "forum"));
  relay.seed(channel(ORBIT_BOARD, "gamma-orbit", "forum"));
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(
    project({ id: "nebula", name: "Nebula", channels: [NEBULA_BOARD] }),
  );
  relay.seed(
    project({ id: "orbit", name: "Orbit", author: OTHER, board: ORBIT_BOARD }),
  );
  // A project that names a board the server does not have changes nothing for the boards it does list.
  relay.seed(
    project({ id: "ghost", name: "Ghost", author: OTHER, channels: [id(77)] }),
  );
  await openAs(page, relay, "/?tab=boards");

  const groups = page.locator('[data-testid^="board-directory-group-"]');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).getByRole("heading")).toHaveText("Nebula");
  await expect(groups.nth(1).getByRole("heading")).toHaveText("Orbit");
  await expect(groups.nth(2).getByRole("heading")).toHaveText("This server");
  await expect(groups.nth(0).getByTestId("board-directory-name")).toHaveText([
    "beta-nebula",
  ]);
  await expect(groups.nth(1).getByTestId("board-directory-name")).toHaveText([
    "gamma-orbit",
  ]);
  await expect(groups.nth(2).getByTestId("board-directory-name")).toHaveText([
    "alpha-films",
  ]);
  await expect(page.getByText("Ghost")).toHaveCount(0);
  // The old line about a list of communities is gone.
  await expect(page.getByTestId("board-directory")).not.toContainText(
    "communities",
  );

  // The project's name opens the project.
  await groups.nth(0).getByTestId("board-directory-project-link").click();
  await expect(page).toHaveURL(new RegExp(`/launchpad/nebula\\?author=${ME}`));
});

test("with no project naming a board, Boards lists them under the server without a heading to tell apart", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(channel(LOOSE_BOARD, "alpha-films", "forum"));
  await openAs(page, relay, "/?tab=boards");
  await expect(page.getByTestId("board-directory-group-server")).toBeVisible();
  await expect(
    page.getByTestId("board-directory-group-server").getByRole("heading"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`board-directory-${LOOSE_BOARD}`),
  ).toBeVisible();
});

/** Names are cut to fit, never pushed past the window (the page can hide a sideways overflow, a box cannot). */
async function expectInsideWindow(locator: Locator, what: string) {
  const box = await locator.boundingBox();
  expect(box, `${what} is on screen`).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0), what).toBeLessThanOrEqual(
    PHONE.width,
  );
}

test.describe("on a phone", () => {
  test.use({ viewport: PHONE });

  test("a project's Boards tab and Home's Boards tab do not scroll sideways, whatever the names", async ({
    page,
  }) => {
    const longProject =
      "The Very Long Named Project That Keeps Going And Going";
    const longBoard =
      "supporters-of-the-very-long-named-project-that-keeps-going";
    const relay = createMockRelay({ deriveChannels: true });
    relay.seed(channel(GENERAL, "general", "stream"));
    relay.seed(channel(NEBULA_BOARD, longBoard, "forum"));
    relay.seed(
      project({ id: "nebula", name: longProject, channels: [NEBULA_BOARD] }),
    );
    relay.seed(channel(LOOSE_BOARD, "film-making", "forum"));
    await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);
    await expect(page.getByTestId("project-boards-list")).toContainText(
      longBoard,
    );
    await expectNoSidewaysScroll(page, "a project's Boards tab");
    await expectInsideWindow(
      page.getByTestId("project-board-name"),
      "a long board name on a project's page",
    );

    await page.goto("/?tab=boards");
    await expect(
      page.getByTestId("board-directory-group-server"),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: longProject }),
    ).toBeVisible();
    await expectNoSidewaysScroll(page, "Home's Boards tab");
    // A heading too long for the screen is cut short with an ellipsis, not left running off the edge.
    const heading = page.getByRole("heading", { name: longProject });
    await expect(heading).toHaveCSS("text-overflow", "ellipsis");
    await expect(heading).toHaveCSS("overflow-x", "hidden");
    await expectInsideWindow(
      heading,
      "a long project name on Home's Boards tab",
    );
    await expectInsideWindow(
      page.getByTestId(`board-directory-${NEBULA_BOARD}`),
      "a board's row on Home's Boards tab",
    );
  });
});
