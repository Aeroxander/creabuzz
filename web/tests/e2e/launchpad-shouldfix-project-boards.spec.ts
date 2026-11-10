import { expect, type Locator, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { createOwningRelay, ownerRecord } from "./board-owners";
import { COMMUNITY_HOST } from "./mock-relay";

/**
 * Boards belong to a project (owner decision): a project's page lists its own boards, the supporters and founders
 * boards are made inside the project and never loose on the server, and Home's Boards tab groups boards under their
 * project's name, with the server's own last.
 *
 * The tie is the project's record: it names the boards it owns (`buzz-channel` tags and its own board), which the server
 * keeps and every client reads, and the board must be one its founder runs (the server's membership record says who). A board no record names is a server board and keeps working. The server is a mock that
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

type Relay = ReturnType<typeof createOwningRelay>;

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
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(channel(NEBULA_BOARD, "nebula-talk", "forum"));
  relay.seed(channel(NEBULA_SECOND, "nebula-ideas", "forum"));
  relay.seed(channel(ORBIT_BOARD, "orbit-talk", "forum"));
  relay.seed(channel(LOOSE_BOARD, "film-making", "forum"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(ownerRecord(NEBULA_SECOND, ME));
  relay.seed(ownerRecord(ORBIT_BOARD, OTHER));
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
  const relay = createOwningRelay();
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
  const relay = createOwningRelay({
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

test("someone who did not publish the project is not offered to make its boards, and gets no empty Boards tab", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(project({ id: "nebula", name: "Nebula", author: OTHER }));
  await openAs(page, relay, `/launchpad/nebula?author=${OTHER}&tab=boards`);

  // A project with no boards shows a visitor no Boards tab: an old link to it opens the project's first page.
  await expect(page.getByTestId("launch-hero")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Boards" })).toHaveCount(0);
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);
});

test("the workspace sidebar no longer offers a loose supporters and founders pair", async ({
  page,
}) => {
  const relay = createOwningRelay();
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
  const relay = createOwningRelay();
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
  const relay = createOwningRelay();
  relay.seed(channel(LOOSE_BOARD, "alpha-films", "forum"));
  relay.seed(channel(NEBULA_BOARD, "beta-nebula", "forum"));
  relay.seed(channel(ORBIT_BOARD, "gamma-orbit", "forum"));
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(ownerRecord(ORBIT_BOARD, OTHER));
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
  const relay = createOwningRelay();
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

test("a project cannot list a board its founder does not run: not another project's, not a plain server board", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(channel(NEBULA_BOARD, "nebula-talk", "forum"));
  relay.seed(channel(ORBIT_BOARD, "orbit-talk", "forum"));
  relay.seed(channel(LOOSE_BOARD, "film-making", "forum"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(ownerRecord(ORBIT_BOARD, OTHER));
  relay.seed(ownerRecord(LOOSE_BOARD, "d".repeat(64)));
  relay.seed(
    project({ id: "nebula", name: "Nebula", channels: [NEBULA_BOARD] }),
  );
  // Orbit's founder made the board and named it. Nebula's founder names it as the project's own board too, and
  // names the server's board, which Nebula's founder did not make either.
  relay.seed(
    project({
      id: "orbit",
      name: "Orbit",
      author: OTHER,
      channels: [ORBIT_BOARD],
    }),
  );
  relay.seed(
    project({
      id: "grab",
      name: "Grab",
      board: ORBIT_BOARD,
      channels: [LOOSE_BOARD],
      at: 200,
    }),
  );

  // The page for the project that claims them lists neither.
  await openAs(page, relay, `/launchpad/grab?author=${ME}&tab=boards`);
  await expect(page.getByTestId("project-boards-empty")).toBeVisible();
  await expect(page.getByTestId("project-boards")).not.toContainText(
    "orbit-talk",
  );
  await expect(page.getByTestId("project-boards")).not.toContainText(
    "film-making",
  );

  // On Home, each board stays with the one that made it; the server's board stays the server's.
  await page.goto("/?tab=boards");
  const groups = page.locator('[data-testid^="board-directory-group-"]');
  await expect(groups.getByRole("heading")).toHaveText([
    "Nebula",
    "Orbit",
    "This server",
  ]);
  await expect(
    page
      .getByTestId("board-directory-group-server")
      .getByTestId("board-directory-name"),
  ).toHaveText(["film-making"]);
});

test("a board that only shares a starter board's name does not stand in for it", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  // The founder's own board, which happens to be called supporters, with a purpose of its own.
  relay.seed(channel(NEBULA_BOARD, "supporters", "forum"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(
    project({ id: "nebula", name: "Nebula", channels: [NEBULA_BOARD] }),
  );
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);

  await expect(page.getByTestId("project-boards-add")).toHaveText(
    "Add supporters and founders boards",
  );
  await page.getByTestId("project-boards-add").click();
  await expect(
    page.getByTestId("project-boards-list").getByTestId("project-board-name"),
  ).toHaveText(["supporters", "supporters", "founders"]);
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);
});

test("if a board's first post is refused, the board is not named yet and trying again sends the post", async ({
  page,
}) => {
  let refusePosts = true;
  const relay = createOwningRelay({
    refuse: (e) =>
      refusePosts && e.kind === 45001
        ? "rate-limited: quota exceeded; retry in 20s"
        : null,
  });
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(project({ id: "nebula", name: "Nebula" }));
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);

  await page.getByTestId("project-boards-add").click();
  await expect(page.getByTestId("project-boards-problem")).toBeVisible();
  // The board has no first post, so the project's record does not name it and the offer is still there.
  expect(named(newestRecord(relay, "nebula") ?? { tags: [] })).toEqual([]);
  expect(created(relay)).toHaveLength(1);
  await expect(page.getByTestId("project-boards-add")).toBeVisible();

  refusePosts = false;
  await page
    .getByTestId("project-boards-problem")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(
    page.getByTestId("project-boards-list").getByTestId("project-board-name"),
  ).toHaveText(["supporters", "founders"]);
  expect(created(relay)).toHaveLength(2);
  const posts = relay.events.filter((e) => e.kind === 45001);
  expect(posts).toHaveLength(2);
  expect(new Set(posts.map((p) => p.tags[0][1])).size).toBe(2);
  expect(named(newestRecord(relay, "nebula"))).toHaveLength(2);
});

test("adding boards keeps what the project's record was changed to since the page loaded", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(project({ id: "nebula", name: "Nebula" }));
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);
  await expect(page.getByTestId("project-boards-add")).toBeVisible();

  // Edited elsewhere after this page read it: a new pitch and a room linked.
  const edited = project({
    id: "nebula",
    name: "Nebula",
    channels: [GENERAL],
    at: 5_000,
  });
  edited.content = JSON.stringify({
    pitch: "Edited somewhere else.",
    stage: "draft",
  });
  relay.seed(edited);

  await page.getByTestId("project-boards-add").click();
  await expect(
    page.getByTestId("project-boards-list").getByTestId("project-board-name"),
  ).toHaveText(["supporters", "founders"]);
  const record = newestRecord(relay, "nebula");
  expect(JSON.parse(record.content).pitch).toBe("Edited somewhere else.");
  expect(named(record)).toContain(GENERAL);
  expect(named(record)).toHaveLength(3);
});

test("two projects with the same name are told apart on Home's Boards tab", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(NEBULA_BOARD, "first-talk", "forum"));
  relay.seed(channel(ORBIT_BOARD, "second-talk", "forum"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(ownerRecord(ORBIT_BOARD, OTHER));
  relay.seed(
    project({ id: "nebula", name: "Nebula", channels: [NEBULA_BOARD] }),
  );
  relay.seed(
    project({
      id: "nebula",
      name: "Nebula",
      author: OTHER,
      channels: [ORBIT_BOARD],
    }),
  );
  await openAs(page, relay, "/?tab=boards");

  const headings = page.locator('[data-testid^="board-directory-group-"] h2');
  await expect(headings).toHaveCount(2);
  const qualifiers = page.getByTestId("board-directory-project-qualifier");
  await expect(qualifiers).toHaveCount(2);
  await expect(qualifiers.first()).toContainText("by ");
  const texts = await headings.allTextContents();
  expect(new Set(texts).size, "no two headings read the same").toBe(2);
});

/** Newer channel records than any board in these specs: enough of them to fill the first page of the channel list. */
function seedFullFirstPage(relay: Relay, at: number) {
  for (let n = 0; n < 230; n++) {
    relay.seed({
      ...channel(id(5000 + n), `room-${n}`, n % 2 ? "stream" : "forum"),
      created_at: at,
    });
  }
}

test("a project's boards older than the first page of the channel list are still its boards, and are not offered again", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(project({ id: "nebula", name: "Nebula" }));
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);
  await page.getByTestId("project-boards-add").click();
  const names = page
    .getByTestId("project-boards-list")
    .getByTestId("project-board-name");
  await expect(names).toHaveText(["supporters", "founders"]);
  expect(created(relay)).toHaveLength(2);

  // The server fills up: 230 channels made after the project's boards, so the newest 200 hold neither of them.
  seedFullFirstPage(relay, Math.floor(Date.now() / 1000) + 10_000);
  await page.reload();
  await expect(names).toHaveText(["supporters", "founders"]);
  await expect(page.getByTestId("project-boards-empty")).toHaveCount(0);
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);
  // Asked for by id, not hoped for in a page of the list.
  const boardIds = created(relay).map((e) => field(e, "h"));
  expect(
    relay
      .reqsReceived()
      .flat()
      .some(
        (f) =>
          f.kinds?.includes(39000) &&
          boardIds.every((b) => (f["#d"] as string[] | undefined)?.includes(b)),
      ),
  ).toBe(true);
  expect(created(relay), "no second pair was made").toHaveLength(2);
});

/** The read of the boards a record names: channel records asked for by id. */
const namedBoardsRead = (f: { kinds?: number[]; [tag: string]: unknown }) =>
  Boolean(f.kinds?.includes(39000)) && Array.isArray(f["#d"]);
/** The read of who runs them. */
const ownersRead = (f: { kinds?: number[] } | undefined) =>
  Boolean(f?.kinds?.includes(39002));

test("when a project's boards cannot be read, the page says so and offers no boards to make until they are read", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(channel(NEBULA_BOARD, "nebula-talk", "forum"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(
    project({ id: "nebula", name: "Nebula", channels: [NEBULA_BOARD] }),
  );
  relay.setClosingSockets((f) => f !== undefined && namedBoardsRead(f));
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);

  await expect(page.getByTestId("project-boards-error")).toBeVisible({
    timeout: 15_000,
  });
  // Not "no boards yet", and nothing to press that would make boards the project may already have.
  await expect(page.getByTestId("project-boards-empty")).toHaveCount(0);
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);

  relay.setClosingSockets(false);
  await page
    .getByTestId("project-boards-error")
    .getByRole("button", { name: /again/i })
    .click();
  await expect(
    page.getByTestId("project-boards-list").getByTestId("project-board-name"),
  ).toHaveText(["nebula-talk"]);
  await expect(page.getByTestId("project-boards-add")).toBeVisible();
  expect(created(relay)).toHaveLength(0);
});

test("while a project's boards are still being read, the page offers no boards to make", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(GENERAL, "general", "stream"));
  relay.seed(channel(NEBULA_BOARD, "nebula-talk", "forum"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(
    project({ id: "nebula", name: "Nebula", channels: [NEBULA_BOARD] }),
  );
  relay.holdReads(namedBoardsRead);
  await openAs(page, relay, `/launchpad/nebula?author=${ME}&tab=boards`);

  await expect(page.getByTestId("project-boards")).toContainText(
    "Loading boards…",
  );
  await expect
    .poll(() => relay.reqsReceived().flat().some(namedBoardsRead))
    .toBe(true);
  await expect(page.getByTestId("project-boards-empty")).toHaveCount(0);
  await expect(page.getByTestId("project-boards-add")).toHaveCount(0);

  relay.releaseReads();
  await expect(
    page.getByTestId("project-boards-list").getByTestId("project-board-name"),
  ).toHaveText(["nebula-talk"]);
});

/** Home's Boards tab, with one board of a project and one of the server's. */
function seedHomeBoards(relay: Relay) {
  relay.seed(channel(LOOSE_BOARD, "alpha-films", "forum"));
  relay.seed(channel(NEBULA_BOARD, "beta-nebula", "forum"));
  relay.seed(ownerRecord(NEBULA_BOARD, ME));
  relay.seed(
    project({ id: "nebula", name: "Nebula", channels: [NEBULA_BOARD] }),
  );
}

test("Home's Boards tab lists the boards while their projects are still being read, then groups them", async ({
  page,
}) => {
  const relay = createOwningRelay();
  seedHomeBoards(relay);
  relay.holdReads(ownersRead);
  await openAs(page, relay, "/?tab=boards");

  // Both boards are there well before the stalled read would give up, under no heading that claims whose they are.
  const names = page.getByTestId("board-directory-name");
  await expect(names).toHaveText(["alpha-films", "beta-nebula"], {
    timeout: 5_000,
  });
  await expect
    .poll(() => relay.reqsReceived().flat().some(ownersRead))
    .toBe(true);
  const groups = page.locator('[data-testid^="board-directory-group-"]');
  await expect(groups.getByRole("heading")).toHaveCount(0);
  await expect(
    page.getByTestId("board-directory-grouping-problem"),
  ).toHaveCount(0);

  relay.releaseReads();
  await expect(groups.getByRole("heading")).toHaveText([
    "Nebula",
    "This server",
  ]);
  await expect(groups.nth(0).getByTestId("board-directory-name")).toHaveText([
    "beta-nebula",
  ]);
});

test("when the projects cannot be read, Home's Boards tab keeps the boards, says the grouping is missing and can try again from the keyboard", async ({
  page,
}) => {
  const relay = createOwningRelay();
  seedHomeBoards(relay);
  relay.setClosingSockets(ownersRead);
  await openAs(page, relay, "/?tab=boards");

  const problem = page.getByTestId("board-directory-grouping-problem");
  await expect(problem).toBeVisible({ timeout: 15_000 });
  await expect(problem).toHaveAttribute("role", "alert");
  await expect(problem).toContainText("Couldn't group boards by project.");
  // The boards stay, and none is passed off as the server's own.
  await expect(page.getByTestId("board-directory-name")).toHaveText([
    "alpha-films",
    "beta-nebula",
  ]);
  await expect(page.getByText("This server", { exact: true })).toHaveCount(0);

  relay.setClosingSockets(false);
  const again = problem.getByRole("button", { name: "Try again" });
  await again.focus();
  await expect(again).toBeFocused();
  await page.keyboard.press("Enter");
  const groups = page.locator('[data-testid^="board-directory-group-"]');
  await expect(groups.getByRole("heading")).toHaveText([
    "Nebula",
    "This server",
  ]);
  await expect(problem).toHaveCount(0);
});

/** `count` chat rooms made after every board in these specs, one a second, so the server's pages cut cleanly. */
function seedNewerRooms(relay: Relay, count: number) {
  for (let n = 0; n < count; n++) {
    relay.seed({
      ...channel(id(20_000 + n), `room-${n}`, "stream"),
      created_at: 10_000 + n,
    });
  }
}
/** A read of the channel list further back than its newest page (not a read of channels by id). */
const olderChannelsRead = (
  f: { kinds?: number[]; [tag: string]: unknown } | undefined,
) =>
  Boolean(f?.kinds?.includes(39000)) &&
  typeof f?.until === "number" &&
  !Array.isArray(f?.["#d"]);

test("Home's Boards tab lists a board older than 200 newer channel records", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(LOOSE_BOARD, "old-talk", "forum"));
  // The newest 200 channel records are all chat rooms: the first page of the channel list holds no board.
  seedNewerRooms(relay, 230);
  await openAs(page, relay, "/?tab=boards");

  await expect(page.getByTestId("board-directory-name")).toHaveText([
    "old-talk",
  ]);
  await expect(page.getByTestId("board-directory-empty")).toHaveCount(0);
  // Every channel record was looked through, so there is nothing more to offer.
  await expect(page.getByTestId("board-directory-more")).toHaveCount(0);
});

test("Home's Boards tab looks through a bounded number of channel records, then offers the older boards", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(LOOSE_BOARD, "old-talk", "forum"));
  seedNewerRooms(relay, 1100);
  await openAs(page, relay, "/?tab=boards");

  const more = page.getByTestId("board-directory-more");
  await expect(more).toContainText("There may be older ones.");
  // Not "there are no boards here": only part of the server's channels was read.
  await expect(page.getByTestId("board-directory-empty")).toHaveCount(0);
  await expect(page.getByTestId("board-directory-name")).toHaveCount(0);
  const listReads = () =>
    relay.reqsReceived().flat().filter(olderChannelsRead).length;
  // Five reads of 200 in the first stretch: four of them further back than the newest page, and no more unasked.
  expect(listReads()).toBe(4);

  await more.getByRole("button", { name: "Show more boards" }).click();
  await expect(page.getByTestId("board-directory-name")).toHaveText([
    "old-talk",
  ]);
  await expect(more).toHaveCount(0);
});

test("when older boards cannot be read, Home's Boards tab keeps the ones listed and can try again from the keyboard", async ({
  page,
}) => {
  const relay = createOwningRelay();
  relay.seed(channel(LOOSE_BOARD, "old-talk", "forum"));
  seedNewerRooms(relay, 1100);
  relay.seed({
    ...channel(NEBULA_BOARD, "new-talk", "forum"),
    created_at: 50_000,
  });
  await openAs(page, relay, "/?tab=boards");

  const names = page.getByTestId("board-directory-name");
  const more = page.getByTestId("board-directory-more");
  await expect(names).toHaveText(["new-talk"]);
  await expect(more).toContainText("older boards that may not be listed yet");

  relay.setClosingSockets(olderChannelsRead);
  const button = more.getByRole("button");
  await button.focus();
  await page.keyboard.press("Enter");
  const problem = page.getByTestId("board-directory-more-problem");
  await expect(problem).toBeVisible({ timeout: 15_000 });
  await expect(problem).toHaveAttribute("role", "alert");
  await expect(problem).toHaveText(
    "Couldn't load more boards. The ones above are still listed.",
  );
  // What was listed stays, and the page does not pass the failure off as the end of the list.
  await expect(names).toHaveText(["new-talk"]);
  await expect(page.getByTestId("board-directory-error")).toHaveCount(0);
  await expect(button).toHaveText("Try again");

  relay.setClosingSockets(false);
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(names).toHaveText(["new-talk", "old-talk"]);
  await expect(more).toHaveCount(0);
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
    const relay = createOwningRelay();
    relay.seed(channel(GENERAL, "general", "stream"));
    relay.seed(channel(NEBULA_BOARD, longBoard, "forum"));
    relay.seed(ownerRecord(NEBULA_BOARD, ME));
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
