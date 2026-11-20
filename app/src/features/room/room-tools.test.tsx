// The room's tools (plan 4.4 and 4.5): report, hide for yourself with Undo and a list to show people again, the team's removal
// and stop (offered only where the server would accept them), perks that keep every other tag of the record, a way out of every
// sheet, and the team's words pinned at the top.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import { parseProject } from "../project/project-record";
import {
  ANA,
  BO,
  COORD,
  draw,
  FOUNDER,
  KEY,
  MATE,
  NOW,
  reset,
  roomPost,
  stored,
  world,
} from "./room-harness";

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
vi.mock("../../lib/mutes", async () => {
  const { useState } = await import("react");
  return {
    useMutes: () => {
      const [muted, setMuted] = useState<Set<string>>(new Set());
      return {
        muted,
        ready: true,
        readable: true,
        pending: false,
        hide: async (pk: string) => setMuted(new Set([...muted, pk])),
        showAgain: async (pk: string) =>
          setMuted(new Set([...muted].filter((m) => m !== pk))),
      };
    },
  };
});
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/u">{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: () => "/p",
}));

import { RoomTab } from "./RoomTab";

const DEE = "d".repeat(64);
const TAGS = [
  ["d", "lantern"],
  ["name", "Lantern"],
  ["t", "dao-launchpad"],
  ["chain-key", KEY],
  ["team", MATE, "designer", "inv-1"],
  ["admission", "curated"],
];
const record = {
  id: "9".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  content: '{"pitch":"Lamps","started":1}',
  tags: TAGS,
  sig: "",
};
const parsed = parseProject(record);
if (!parsed) throw new Error("no project");
const project = parsed;
const profiles = {
  [ANA]: { name: "Ana", display_name: "Ana" },
  [BO]: { name: "Bo", display_name: "Bo" },
  [DEE]: { name: "Dee", display_name: "Dee" },
  [MATE]: { name: "Max", display_name: "Max" },
  [FOUNDER]: { name: "Fay", display_name: "Fay" },
};

function room(me: string, team = [FOUNDER, MATE, DEE]) {
  world.me = me;
  world.events.push(record as never);
  return draw(
    <RoomTab
      numbers={parsedExample()}
      profiles={profiles}
      project={project}
      team={team}
    />,
  );
}
const more = (name: string) =>
  screen.findByRole("button", { name: `More actions for ${name}'s post` });
const menu = () => screen.getByTestId("post-menu");

beforeEach(() => {
  reset();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("report", () => {
  it("sends one of the five plain choices to the people who run the server, and says what happens next", async () => {
    const post = roomPost(ANA, "Buy my coin", NOW - 50);
    room(BO);
    fireEvent.click(await more("Ana"));
    expect(
      within(menu()).queryByRole("button", { name: "Remove this post" }),
    ).toBeNull();
    fireEvent.click(within(menu()).getByRole("button", { name: "Report" }));
    const sheet = await screen.findByTestId("report-sheet");
    expect(
      within(sheet)
        .getAllByRole("radio")
        .map((r) => (r.closest("label") as HTMLElement).textContent),
    ).toEqual([
      "Spam",
      "Pretending to be someone",
      "Rude or harmful",
      "Illegal",
      "Something else",
    ]);
    expect(
      (
        within(sheet).getByRole("button", {
          name: "Send report",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(within(sheet).getByLabelText("Spam"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Send report" }));
    expect(
      await within(sheet).findByText(
        "Thanks. The people who run this server will look at it.",
      ),
    ).toBeTruthy();
    expect(world.published[0].kind).toBe(1984);
    expect(world.published[0].tags).toEqual([
      ["e", post.id, "spam"],
      ["p", ANA],
    ]);
  });

  it("says when it could not be sent and keeps the choice", async () => {
    roomPost(ANA, "Buy my coin", NOW - 50);
    room(BO);
    world.refuse = "error: db error";
    fireEvent.click(await more("Ana"));
    fireEvent.click(within(menu()).getByRole("button", { name: "Report" }));
    const sheet = await screen.findByTestId("report-sheet");
    fireEvent.click(within(sheet).getByLabelText("Illegal"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Send report" }));
    expect(
      await within(sheet).findByText("The report was not sent. Try again."),
    ).toBeTruthy();
    expect(
      (within(sheet).getByLabelText("Illegal") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("is not offered on your own post", async () => {
    roomPost(BO, "Mine", NOW - 50);
    room(BO);
    expect(
      screen.queryByRole("button", { name: "More actions for Bo's post" }),
    ).toBeNull();
    await screen.findByText("Mine");
    expect(
      screen.queryByRole("button", { name: "More actions for Bo's post" }),
    ).toBeNull();
  });
});

describe("hiding a person for yourself", () => {
  it("hides their posts at once, says only you stop seeing them, and Undo brings them back", async () => {
    roomPost(ANA, "Noisy words", NOW - 50);
    roomPost(BO, "Quiet words", NOW - 60);
    room(DEE, [FOUNDER]);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Hide Ana's posts" }),
    );
    expect(
      await screen.findByText(
        "You will not see posts by Ana any more. Only you stop seeing them.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Noisy words")).toBeNull();
    expect(screen.getByText("Quiet words")).toBeTruthy();
    // Nothing was sent to anyone.
    expect(world.published).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Noisy words")).toBeTruthy();
    expect(screen.queryByTestId("room-hidden-note")).toBeNull();
  });

  it("lists hidden people with a press to show each again", async () => {
    roomPost(ANA, "Noisy words", NOW - 50);
    room(DEE, [FOUNDER]);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Hide Ana's posts" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Hidden people (1)" }),
    );
    const sheet = await screen.findByTestId("hidden-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: /^Show again/ }));
    await waitFor(() => expect(screen.getByText("Noisy words")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Hidden people/ })).toBeNull();
  });
});

describe("the team's tools", () => {
  it("a team member removes a stranger's post with a public reason, and the post is gone", async () => {
    const post = roomPost(ANA, "Rude words", NOW - 50);
    room(MATE);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Remove this post" }),
    );
    const sheet = await screen.findByTestId("remove-sheet");
    fireEvent.change(
      within(sheet).getByLabelText(
        "Say why. The reason is kept in a public log.",
      ),
      {
        target: { value: "Rude to others" },
      },
    );
    // The relay would take it out of its answers; the stand-in does too.
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(world.published[0].kind).toBe(9005);
    expect(world.published[0].tags).toEqual([
      ["e", post.id],
      ["public_reason", "Rude to others"],
    ]);
    expect(world.published[0].tags.some((t) => t[0] === "h")).toBe(false);
  });

  it("says when a removal failed and keeps the sheet and the reason", async () => {
    roomPost(ANA, "Rude words", NOW - 50);
    room(MATE);
    world.refuse =
      "restricted: only the people who keep this room can remove a post from it";
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Remove this post" }),
    );
    const sheet = await screen.findByTestId("remove-sheet");
    fireEvent.change(
      within(sheet).getByLabelText(
        "Say why. The reason is kept in a public log.",
      ),
      { target: { value: "Why" } },
    );
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
    expect(
      await within(sheet).findByText("The post was not removed. Try again."),
    ).toBeTruthy();
    expect(
      (
        within(sheet).getByLabelText(
          "Say why. The reason is kept in a public log.",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Why");
  });

  it("stops a person writing for the days chosen, naming the wallets they linked, and can let them write again", async () => {
    const wallet = `0x${"11".repeat(20)}`;
    stored(
      ANA,
      37017,
      [
        ["d", wallet],
        ["address", wallet],
      ],
      "{}",
      NOW - 5000,
    );
    roomPost(ANA, "Heated words", NOW - 50);
    room(FOUNDER);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Stop Ana writing here" }),
    );
    const sheet = await screen.findByTestId("mute-sheet");
    expect(
      within(sheet).getByText(
        "They can still read. You can lift this any time.",
      ),
    ).toBeTruthy();
    expect(
      within(sheet)
        .getAllByRole("radio")
        .map((r) => (r.closest("label") as HTMLElement).textContent),
    ).toEqual(["1 day", "7 days", "30 days"]);
    fireEvent.click(within(sheet).getByLabelText("30 days"));
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Stop writing" }),
    );
    await waitFor(() => expect(world.published).toHaveLength(1));
    const sent = world.published[0];
    expect(sent.kind).toBe(47003);
    expect(sent.tags).toContainEqual(["a", COORD]);
    expect(sent.tags).toContainEqual(["room-mute", ANA]);
    expect(sent.tags).toContainEqual(["room-mute-wallet", wallet]);
    const until = Number(sent.tags.find((t) => t[0] === "expiration")?.[1]);
    expect(until).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86_400);
    expect(until).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 30 * 86_400,
    );
  });

  it("offers 'Let Ana write again' for a person who is stopped, and that ends the stop at once", async () => {
    roomPost(ANA, "Heated words", NOW - 50);
    world.stops = [{ person: ANA, wallets: [], until: NOW + 5000 }];
    room(FOUNDER);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Let Ana write again" }),
    );
    await waitFor(() => expect(world.published).toHaveLength(1));
    const until = Number(
      world.published[0].tags.find((t) => t[0] === "expiration")?.[1],
    );
    expect(until).toBeLessThan(Math.floor(Date.now() / 1000));
  });

  it("offers only what the server would accept: not on the founder's post, not on another team member's, not for a stranger", async () => {
    roomPost(FOUNDER, "From the founder", NOW - 10);
    roomPost(DEE, "From a teammate", NOW - 20);
    roomPost(ANA, "From a backer", NOW - 30);
    // A team member removes a backer's post, and nothing of the founder's or another team member's.
    const asMate = room(MATE);
    for (const [name, remove, stop] of [
      ["Fay", false, false],
      ["Dee", false, true],
      ["Ana", true, true],
    ] as const) {
      fireEvent.click(await more(name));
      expect(
        !!within(menu()).queryByRole("button", { name: "Remove this post" }),
      ).toBe(remove);
      expect(
        !!within(menu()).queryByRole("button", {
          name: `Stop ${name} writing here`,
        }),
      ).toBe(stop);
      fireEvent.keyDown(menu(), { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("post-menu")).toBeNull());
    }
    asMate.unmount();
    // The founder removes a teammate's post too, but never their own.
    room(FOUNDER);
    fireEvent.click(await more("Dee"));
    expect(
      within(menu()).queryByRole("button", { name: "Remove this post" }),
    ).not.toBeNull();
    fireEvent.keyDown(menu(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("post-menu")).toBeNull());
    expect(
      screen.queryByRole("button", { name: "More actions for Fay's post" }),
    ).toBeNull();
    cleanup();
    // A backer who is not on the team sees neither.
    room(BO);
    fireEvent.click(await more("Dee"));
    expect(
      within(menu()).queryByRole("button", { name: "Remove this post" }),
    ).toBeNull();
    expect(within(menu()).queryByRole("button", { name: /^Stop / })).toBeNull();
  });
});

describe("perks", () => {
  it("only the founder edits them, and saving keeps every other tag and the content of the record", async () => {
    const view = room(BO);
    await screen.findByTestId("room");
    expect(screen.queryByRole("button", { name: /perks/i })).toBeNull();
    view.unmount();
    room(FOUNDER);
    fireEvent.click(await screen.findByRole("button", { name: "Add perks" }));
    const sheet = await screen.findByTestId("perks-sheet");
    const box = within(sheet).getByLabelText(
      "What do people who back this get?",
    );
    expect(
      within(sheet).getByText(
        "Say it in words, for example early looks at what you are making. Do not promise money.",
      ),
    ).toBeTruthy();
    expect(
      within(sheet).getByText(
        "These are the team's own words. They are not money and not a promise of a return.",
      ),
    ).toBeTruthy();
    fireEvent.change(box, {
      target: { value: "Early looks at what we make." },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(world.published).toHaveLength(1));
    const sent = world.published[0];
    expect(sent.kind).toBe(37001);
    expect(sent.tags.slice(0, TAGS.length)).toEqual(TAGS);
    expect(sent.tags.at(-1)).toEqual(["perks", "Early looks at what we make."]);
    expect(sent.content).toBe(record.content);
  });

  it("builds on the newest record, so a team change made elsewhere stays", async () => {
    // Another device saved a newer record that added a team member.
    const newer = {
      ...record,
      id: "8".repeat(64),
      created_at: NOW - 10,
      tags: [...TAGS, ["team", DEE, "writer", "inv-2"]],
    };
    world.events.push(newer as never);
    room(FOUNDER);
    fireEvent.click(await screen.findByRole("button", { name: "Add perks" }));
    const sheet = await screen.findByTestId("perks-sheet");
    fireEvent.change(
      within(sheet).getByLabelText("What do people who back this get?"),
      { target: { value: "A say in small choices." } },
    );
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(world.published.length).toBeGreaterThan(0));
    expect(world.published.at(-1)?.tags).toContainEqual([
      "team",
      DEE,
      "writer",
      "inv-2",
    ]);
  });
});

describe("every sheet has a way out that is not Escape", () => {
  it("has a visible Close in each", async () => {
    roomPost(ANA, "Words", NOW - 50);
    room(FOUNDER);
    const out = async (testId: string) => {
      const sheet = await screen.findByTestId(testId);
      const close = within(sheet).getByRole("button", { name: "Close" });
      fireEvent.click(close);
      await waitFor(() => expect(screen.queryByTestId(testId)).toBeNull());
    };
    fireEvent.click(await more("Ana"));
    await out("post-menu");
    for (const [label, sheetId] of [
      ["Remove this post", "remove-sheet"],
      ["Stop Ana writing here", "mute-sheet"],
      ["Report", "report-sheet"],
    ] as const) {
      fireEvent.click(await more("Ana"));
      fireEvent.click(within(menu()).getByRole("button", { name: label }));
      await out(sheetId);
    }
    fireEvent.click(screen.getByRole("button", { name: "Add perks" }));
    await out("perks-sheet");
  });
});

describe("what the team said", () => {
  it("pins the team's newest notice at the top, with its label and date, so a quiet room is never blank", async () => {
    stored(
      FOUNDER,
      47003,
      [["a", COORD]],
      JSON.stringify({ title: "Week 3", body: "We shipped the lids." }),
      NOW - 500,
    );
    stored(
      FOUNDER,
      47003,
      [["a", COORD]],
      JSON.stringify({ title: "Week 4", body: "Lamps are in." }),
      NOW - 100,
    );
    roomPost(ANA, "A backer's post", NOW - 50);
    room(BO);
    const pinned = await screen.findByTestId("room-notice-pinned");
    expect(pinned.textContent).toMatch(/From the team, pinned/);
    expect(pinned.textContent).toMatch(/Week 4/);
    // The older notice sits among the posts, labelled too.
    const list = screen.getByTestId("room-list");
    expect(within(list).getByTestId("room-notice").textContent).toMatch(
      /From the team.*Week 3/,
    );
    expect(screen.queryByText("A backer's post")).not.toBeNull();
  });
});

describe("a room that cannot be read", () => {
  it("says so and offers to try again", async () => {
    const mod = await import("./room-harness");
    const original = mod.relayMock.readMulti;
    mod.relayMock.readMulti = async () => {
      throw new Error("down");
    };
    room(BO);
    expect(
      await screen.findByText("The room could not be read. Try again."),
    ).toBeTruthy();
    mod.relayMock.readMulti = original;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("room-empty")).toBeTruthy();
  });
});

describe("the sheets have no accessibility violations", () => {
  it("the menu and the report sheet", async () => {
    roomPost(ANA, "Words", NOW - 50);
    room(BO);
    fireEvent.click(await more("Ana"));
    expect(await seriousViolations(document.body)).toEqual([]);
    fireEvent.click(within(menu()).getByRole("button", { name: "Report" }));
    await screen.findByTestId("report-sheet");
    expect(await seriousViolations(document.body)).toEqual([]);
  });
});
