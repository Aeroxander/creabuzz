// What the room says when posts are missing: a removed post shows the team's reason (from the server's public log), the room
// says when there are no earlier posts and when it read only the newest, and the team is told when its list of stops on people
// was cut. The log is the server's own: an entry signed by anyone else is not a removal, and one that names another room's
// thread is not shown here.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { KIND_LAUNCH_UPDATE } from "@creaton/core/kinds.ts";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import { parseProject } from "../project/project-record";
import type { SignedEvent } from "../posts/use-posts";
import {
  ANA,
  BO,
  COORD,
  draw,
  FOUNDER,
  KEY,
  NOW,
  nextId,
  reset,
  roomPost,
  roomTags,
  stored,
  world,
} from "./room-harness";
import { missingTargets, REMOVALS_SHOWN, removalsOf } from "./room-removals";
import { NOTES_READ } from "./use-room";

vi.mock(
  "../../lib/relay",
  async () => (await import("./room-harness")).relayMock,
);
vi.mock(
  "./use-room-standing",
  async () => (await import("./room-harness")).standingMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("./room-harness")).accountMock,
);
vi.mock("../tasks/use-tasks", () => ({
  useProjectTasks: () => ({ data: { tasks: [] } }),
}));
vi.mock("../../lib/mutes", () => ({
  useMutes: () => ({
    muted: new Set<string>(),
    ready: true,
    readable: true,
    pending: false,
    hide: async () => undefined,
    showAgain: async () => undefined,
  }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/u">{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: () => "/p",
}));

import { RoomTab } from "./RoomTab";

const SERVER = "5".repeat(64);
const LOG = 45004;
const parsed = parseProject({
  id: "9".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  content: '{"pitch":"Lamps"}',
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
    ["chain-key", KEY],
  ],
});
if (!parsed) throw new Error("no project");
const project = parsed;
const numbers = parsedExample();
const profiles = { [ANA]: { name: "Ana" }, [BO]: { name: "Bo" } };

const show = () =>
  draw(
    <RoomTab
      numbers={numbers}
      profiles={profiles}
      project={project}
      team={[FOUNDER]}
    />,
  );

/** The server's public log entry for a removal. */
function logEntry(options: {
  target: string;
  author: string;
  thread?: string;
  reason?: string;
  signer?: string;
  at?: number;
}) {
  return stored(
    options.signer ?? SERVER,
    LOG,
    [
      ["action", "remove"],
      ["e", options.target],
      ...(options.thread ? [["thread", options.thread]] : []),
      ["p", options.author],
    ],
    options.reason ?? "",
    options.at ?? NOW - 10,
  );
}
beforeEach(() => {
  reset();
  sessionStorage.clear();
  applyServerSettings({ investing: true, self: SERVER });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("which removals belong to a room (pure)", () => {
  const entry = (tags: string[][], pubkey = SERVER, at = 100): SignedEvent =>
    ({
      id: nextId(),
      pubkey,
      kind: LOG,
      tags,
      content: " Off topic ",
      created_at: at,
      sig: "",
    }) as SignedEvent;
  const T = "a".repeat(64);
  const ROOT = "b".repeat(64);
  it("keeps an entry that names a thread of this room or a post the room's answers point at, and only the server's", () => {
    const named = entry([
      ["action", "remove"],
      ["e", T],
      ["thread", ROOT],
    ]);
    const orphan = entry([
      ["action", "remove"],
      ["e", T.replace(/a/g, "c")],
    ]);
    const other = entry([
      ["action", "remove"],
      ["e", T],
      ["thread", "d".repeat(64)],
    ]);
    const forged = entry(
      [
        ["action", "remove"],
        ["e", T],
        ["thread", ROOT],
      ],
      ANA,
    );
    const got = removalsOf({
      log: [named, orphan, other, forged],
      server: SERVER,
      roots: new Set([ROOT]),
      missing: new Set([T.replace(/a/g, "c")]),
    });
    expect(got.shown.map((r) => r.target).sort()).toEqual(
      [T, T.replace(/a/g, "c")].sort(),
    );
    expect(got.shown[0]?.reason).toBe("Off topic");
    // With no server key known nothing is believed.
    expect(
      removalsOf({
        log: [named],
        server: null,
        roots: new Set([ROOT]),
        missing: new Set(),
      }).shown,
    ).toEqual([]);
  });
  it("lists the newest few and says when it cut", () => {
    const log = Array.from({ length: REMOVALS_SHOWN + 3 }, (_, i) =>
      entry(
        [
          ["action", "remove"],
          ["e", (i + 1).toString(16).padStart(64, "0")],
          ["thread", ROOT],
        ],
        SERVER,
        1000 + i,
      ),
    );
    const got = removalsOf({
      log,
      server: SERVER,
      roots: new Set([ROOT]),
      missing: new Set(),
    });
    expect(got.shown).toHaveLength(REMOVALS_SHOWN);
    expect(got.cut).toBe(true);
    expect(got.shown[0]?.at).toBe(1000 + REMOVALS_SHOWN + 2);
  });
  it("finds the ids the room's answers point at and cannot find", () => {
    const root = roomPost(ANA, "root", NOW - 50);
    const orphan = stored(
      BO,
      1,
      [...roomTags, ["e", T, "", "root"]],
      "answer to a removed post",
      NOW - 40,
    );
    expect([...missingTargets([root, orphan])]).toEqual([T]);
  });
});

describe("a removed post shows why", () => {
  it("under the room: the team's words for a removed reply and for a removed post its answers still point at", async () => {
    const root = roomPost(ANA, "Lamps arrive on Friday", NOW - 100);
    const goneReply = "1".repeat(64);
    logEntry({
      target: goneReply,
      author: BO,
      thread: root.id,
      reason: "Rude to Ana",
      at: NOW - 20,
    });
    const goneRoot = "2".repeat(64);
    stored(
      BO,
      1,
      [...roomTags, ["e", goneRoot, "", "root"]],
      "I agree",
      NOW - 60,
    );
    logEntry({ target: goneRoot, author: ANA, reason: "Spam", at: NOW - 30 });
    // Another room's removal, and one nobody signed as the server: neither is shown here.
    logEntry({
      target: "3".repeat(64),
      author: ANA,
      thread: "4".repeat(64),
      reason: "Elsewhere",
    });
    logEntry({
      target: "5".repeat(64),
      author: ANA,
      thread: root.id,
      reason: "Forged",
      signer: BO,
    });
    show();
    const list = await screen.findByTestId("room-removed");
    const lines = within(list)
      .getAllByRole("listitem")
      .map((l) => l.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/A post was removed here\. Reason: Rude to Ana/);
    expect(lines[1]).toMatch(/A post was removed here\. Reason: Spam/);
    expect(list.textContent).not.toMatch(/Elsewhere|Forged/);
    expect(
      within(list).getByRole("heading", { name: "Removed by the team" }),
    ).toBeTruthy();
  });

  it("says the team gave no reason when it gave none, and draws the reason as plain text", async () => {
    const root = roomPost(ANA, "Lamps arrive on Friday", NOW - 100);
    logEntry({ target: "1".repeat(64), author: BO, thread: root.id });
    logEntry({
      target: "2".repeat(64),
      author: BO,
      thread: root.id,
      reason: "<img src=x onerror=alert(1)> rude",
      at: NOW - 5,
    });
    show();
    const list = await screen.findByTestId("room-removed");
    expect(list.textContent).toMatch(/The team gave no reason/);
    expect(list.querySelector("img")).toBeNull();
    expect(list.textContent).toContain("<img src=x onerror=alert(1)> rude");
  });

  it("shows nothing when the server's key is not known, whatever the log says", async () => {
    applyServerSettings(null);
    const root = roomPost(ANA, "Lamps arrive on Friday", NOW - 100);
    logEntry({
      target: "1".repeat(64),
      author: BO,
      thread: root.id,
      reason: "Rude",
    });
    show();
    await screen.findByText("Lamps arrive on Friday");
    expect(screen.queryByTestId("room-removed")).toBeNull();
  });
});

describe("the room says when there is no more", () => {
  it("after the last page of earlier posts: that is every post, and no button", async () => {
    for (let i = 0; i < 35; i += 1) roomPost(ANA, `post ${i}`, NOW - 1000 + i);
    show();
    fireEvent.click(await screen.findByTestId("room-more"));
    expect(screen.queryByTestId("room-more")).toBeNull();
    expect(screen.getByTestId("room-no-more").textContent).toBe(
      "That is every post this room has.",
    );
  });
  it("says nothing of earlier posts in a short room", async () => {
    roomPost(ANA, "one", NOW - 10);
    show();
    await screen.findByText("one");
    expect(screen.queryByTestId("room-no-more")).toBeNull();
    expect(screen.queryByTestId("room-read-cut")).toBeNull();
  });
  it("says older posts are not read when the read took as many as it takes", async () => {
    for (let i = 0; i < NOTES_READ; i += 1)
      roomPost(ANA, `p${i}`, NOW - 5000 + i);
    show();
    fireEvent.click(await screen.findByTestId("room-more"));
    for (let i = 0; i < 6; i += 1) {
      const more = screen.queryByTestId("room-more");
      if (more) fireEvent.click(more);
    }
    expect(screen.queryByTestId("room-more")).toBeNull();
    expect((await screen.findByTestId("room-read-cut")).textContent).toMatch(
      /newest posts only/,
    );
    expect(screen.queryByTestId("room-no-more")).toBeNull();
  });
});

describe("the team is told when its list of stops was cut", () => {
  const records = (n: number) => {
    for (let i = 0; i < n; i += 1)
      stored(
        FOUNDER,
        KIND_LAUNCH_UPDATE,
        [["a", COORD]],
        "update",
        NOW - 5000 + i,
      );
  };
  it("to the team, and not to anyone else", async () => {
    world.me = FOUNDER;
    records(200);
    roomPost(ANA, "hello", NOW - 10);
    show();
    expect((await screen.findByTestId("room-stops-cut")).textContent).toMatch(
      /Only the newest 200 team records are read here/,
    );
    cleanup();
    world.me = ANA;
    show();
    await screen.findByText("hello");
    expect(screen.queryByTestId("room-stops-cut")).toBeNull();
  });
  it("not when the list is shorter than the read", async () => {
    world.me = FOUNDER;
    records(199);
    roomPost(ANA, "hello", NOW - 10);
    show();
    await screen.findByText("hello");
    expect(screen.queryByTestId("room-stops-cut")).toBeNull();
  });
});
