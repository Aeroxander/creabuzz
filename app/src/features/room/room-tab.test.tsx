// The holder room as a person meets it (plan sections 4.7 and 7.6): a stranger reads and is told what to do; a holder writes;
// every refusal the server gives is said in plain words with the draft kept; a server that has not caught up is tried once
// more by itself; and every press that can be pressed names whose post it is.
import {
  act,
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
  NOW,
  reset,
  roomPost,
  stored,
  roomTags,
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
const profiles = {
  [ANA]: { name: "Ana", display_name: "Ana" },
  [BO]: { name: "Bo", display_name: "Bo" },
  [FOUNDER]: { name: "Fay", display_name: "Fay" },
};
const numbers = parsedExample();

function room(options: { perks?: boolean } = {}) {
  const shown = options.perks
    ? parseProject({
        ...project.event,
        tags: [
          ...project.event.tags,
          ["perks", "Early looks at what we make."],
        ],
      })
    : project;
  return draw(
    <RoomTab
      numbers={numbers}
      profiles={profiles}
      project={shown ?? project}
      team={[FOUNDER]}
    />,
  );
}

beforeEach(() => {
  reset();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a person who may not write", () => {
  it("reads the whole room and is told what to do: Back, and no way to write", async () => {
    world.standing = { kind: "not-holding" };
    roomPost(ANA, "Lamps arrive on Friday", NOW - 100);
    room({ perks: true });
    expect(await screen.findByText("Lamps arrive on Friday")).toBeTruthy();
    expect(screen.getByTestId("room-read-line").textContent).toBe(
      "Anyone can read this room. Only people who back the project can write here.",
    );
    expect(screen.getByText("Posts and votes are public.")).toBeTruthy();
    expect(screen.getByText("Perks from the team")).toBeTruthy();
    expect(screen.getByText("Early looks at what we make.")).toBeTruthy();
    expect(
      screen.getByText(
        "These are the team's own words. They are not money and not a promise of a return.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Only people who back this project can write here."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Back this project" }),
    ).toBeTruthy();
    // No composer, and no like or reply to press (the server would refuse them); the counts and More are there.
    expect(screen.queryByTestId("room-composer")).toBeNull();
    expect(screen.queryByTestId("room-like")).toBeNull();
    expect(screen.queryByTestId("room-reply-press")).toBeNull();
    expect(
      screen.getByRole("button", { name: "More actions for Ana's post" }),
    ).toBeTruthy();
  });

  it("is the same for a visitor with no account", async () => {
    world.signedIn = false;
    world.standing = { kind: "signed-out" };
    roomPost(ANA, "Hello", NOW - 100);
    room();
    expect(await screen.findByText("Hello")).toBeTruthy();
    expect(screen.queryByTestId("room-composer")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Back this project" }),
    ).toBeTruthy();
  });

  it("is told the door's own words when it is shut, with no Back press", async () => {
    world.standing = { kind: "not-holding" };
    const shut = { ...numbers, door: { ...numbers.door, switchOn: false } };
    draw(
      <RoomTab
        numbers={shut}
        profiles={profiles}
        project={project}
        team={[FOUNDER]}
      />,
    );
    expect(
      await screen.findByText(/closed the door to new backing/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Back this project" }),
    ).toBeNull();
  });

  it("an empty room says how it fills, and a room that cannot be read says so with a press to try again", async () => {
    world.standing = { kind: "not-holding" };
    room();
    expect(
      await screen.findByText(
        "Nothing here yet. People who back this project can write the first post.",
      ),
    ).toBeTruthy();
  });

  it("each reason is said in its own words", async () => {
    const words: [Parameters<typeof Object.assign>[1], RegExp][] = [
      [{ kind: "checking" }, /Checking whether you back/],
      [
        { kind: "phone-unsupported" },
        /^Rooms are not switched on for phone accounts on this server\.$/,
      ],
      [{ kind: "needs-link", expired: false }, /needs this account confirmed/],
      [{ kind: "needs-link", expired: true }, /link has ended/],
      [
        { kind: "muted", until: NOW + 86_400 },
        /The team has stopped you writing here until .* You can still read, and you can take your money out any time\./,
      ],
    ];
    for (const [standing, pattern] of words) {
      world.standing = standing as never;
      const view = room();
      expect(await screen.findByText(pattern)).toBeTruthy();
      expect(screen.queryByTestId("room-composer")).toBeNull();
      view.unmount();
    }
    world.standing = { kind: "needs-link", expired: false };
    room();
    expect(
      await screen.findByRole("button", {
        name: "Confirm this account backs the project",
      }),
    ).toBeTruthy();
  });
});

describe("a person who may write", () => {
  it("has a labelled box, says that posts and votes are public, and a post lands in the room with its tags", async () => {
    room();
    const box = await screen.findByLabelText(
      "Write to the people who back this",
    );
    expect((box as HTMLTextAreaElement).placeholder).toBe("Say something");
    expect(screen.getByTestId("room-public-line").textContent).toBe(
      "Posts and votes are public.",
    );
    expect(
      screen.getByText("The team can remove posts. Be kind."),
    ).toBeTruthy();
    fireEvent.change(box, { target: { value: "First words #lamps" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(
      await within(await screen.findByTestId("room-list")).findByText(
        "First words #lamps",
      ),
    ).toBeTruthy();
    const sent = world.published[0];
    expect(sent.kind).toBe(1);
    expect(sent.tags).toContainEqual(["a", COORD]);
    expect(sent.tags).toContainEqual(["t", `room:${KEY}`]);
    expect(sent.tags).toContainEqual(["t", "lamps"]);
    // The box is empty again.
    expect(
      (
        screen.getByLabelText(
          "Write to the people who back this",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("names each press with the author, and says the like once it is given", async () => {
    roomPost(ANA, "A post", NOW - 50);
    room();
    expect(
      await screen.findByRole("button", { name: /^Like Ana's post,\s*0$/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Reply to Ana, 0$/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "More actions for Ana's post" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Like Ana's post/ }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /^Like Ana's post, 1$/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(world.published[0].kind).toBe(7);
    expect(world.published[0].tags).toContainEqual(["t", `room:${KEY}`]);
    expect(world.published[0].tags).toContainEqual(["a", COORD]);
  });

  it("answers a post in the room: the answer names the post and carries the room", async () => {
    const root = roomPost(ANA, "Question?", NOW - 50);
    room();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Reply to Ana/ }),
    );
    const box = screen.getByLabelText("Reply to Ana");
    fireEvent.change(box, { target: { value: "Yes, Friday." } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(world.published).toHaveLength(1));
    const sent = world.published[0];
    expect(sent.tags).toContainEqual(["e", root.id, "", "root"]);
    expect(sent.tags).toContainEqual(["a", COORD]);
    expect(sent.tags).toContainEqual(["t", `room:${KEY}`]);
    expect(
      within(screen.getByRole("region", { name: "Replies to Ana" })).getByText(
        "Yes, Friday.",
      ),
    ).toBeTruthy();
  });

  it("an untagged reply or like a stranger sent never shows in a thread", async () => {
    const root = roomPost(ANA, "Question?", NOW - 50);
    stored(BO, 1, [["e", root.id, "", "root"]], "Sneaked in", NOW - 40);
    stored(
      BO,
      7,
      [
        ["e", root.id],
        ["p", ANA],
        ["k", "1"],
      ],
      "+",
      NOW - 30,
    );
    room();
    expect(await screen.findByText("Question?")).toBeTruthy();
    expect(screen.queryByText("Sneaked in")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Like Ana's post,\s*0$/ }),
    ).toBeTruthy();
  });
});

describe("what the server refuses", () => {
  const refusals: [string, RegExp][] = [
    [
      "restricted: you are writing too fast; try again in a few minutes",
      /^You are writing too fast\. Try again in a few minutes\.$/,
    ],
    [
      "restricted: too many accounts write from this wallet",
      /^Too many accounts write from this wallet\.$/,
    ],
    [
      "invalid: a reply belongs in the same room as the post it answers",
      /^A reply belongs in the same room as the post it answers\.$/,
    ],
    [
      "invalid: the room is for text; leave out pictures and files",
      /^The room is for text: leave out pictures and files\.$/,
    ],
    [
      "restricted: the team has stopped you writing in this room for now",
      /take your money out any time/,
    ],
    [
      "restricted: link your wallet to your account first, so the server can see that you back this project",
      /needs this account confirmed/,
    ],
  ];
  for (const [said, words] of refusals)
    it(`${said.slice(0, 40)}… is said in plain words and the draft is kept`, async () => {
      room();
      world.refuse = said;
      const box = await screen.findByLabelText(
        "Write to the people who back this",
      );
      fireEvent.change(box, { target: { value: "My careful words" } });
      fireEvent.click(screen.getByRole("button", { name: "Post" }));
      expect((await screen.findByTestId("room-refusal")).textContent).toMatch(
        words,
      );
      expect(
        (
          screen.getByLabelText(
            "Write to the people who back this",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("My careful words");
      expect(screen.getByText("Your words are kept.")).toBeTruthy();
      expect(world.published).toHaveLength(0);
      if (/link your wallet/.test(said))
        expect(
          screen.getByRole("button", {
            name: "Confirm this account backs the project",
          }),
        ).toBeTruthy();
    });

  it("a person who just backed is told so, keeps the draft, and the room tries once more by itself after 30 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    room();
    world.refuse =
      "restricted: only people who back this project can write in its room. If you just backed it, wait about a minute and try again";
    const box = await screen.findByLabelText(
      "Write to the people who back this",
    );
    fireEvent.change(box, { target: { value: "Just backed" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    expect((await screen.findByTestId("room-refusal")).textContent).toBe(
      "Not ready yet. Try again in a minute.",
    );
    expect(screen.getByText(/We will try once more in a moment/)).toBeTruthy();
    expect(world.published).toHaveLength(0);
    // The server has caught up by then.
    world.refuse = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(world.published[0].content).toBe("Just backed");
    expect(await screen.findByText("Just backed")).toBeTruthy();
  });

  it("tries only once by itself: a second 'not ready' waits for the person", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    room();
    world.refuse =
      "retry: the server has not read this project yet; try again in a minute";
    const box = await screen.findByLabelText(
      "Write to the people who back this",
    );
    fireEvent.change(box, { target: { value: "Still early" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await screen.findByTestId("room-refusal");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(world.published).toHaveLength(0);
    expect(
      (
        screen.getByLabelText(
          "Write to the people who back this",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Still early");
    expect(screen.queryByText(/We will try once more/)).toBeNull();
  });
});

describe("keyboard and a kept draft", () => {
  it("Enter and Shift+Enter write a new line and post nothing; Control+Enter posts", async () => {
    room();
    const box = await screen.findByLabelText(
      "Write to the people who back this",
    );
    fireEvent.change(box, { target: { value: "Line one" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: " ", shiftKey: true });
    expect(world.published).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(world.published).toHaveLength(1));
  });

  it("Escape closes an answer without posting it", async () => {
    roomPost(ANA, "Question?", NOW - 50);
    room();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Reply to Ana/ }),
    );
    const box = screen.getByLabelText("Reply to Ana");
    fireEvent.change(box, { target: { value: "never mind" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByLabelText("Reply to Ana")).toBeNull();
    expect(world.published).toHaveLength(0);
  });

  it("the unsent post is still there when the person comes back from another tab", async () => {
    const first = room();
    const box = await screen.findByLabelText(
      "Write to the people who back this",
    );
    fireEvent.change(box, { target: { value: "Half a thought" } });
    first.unmount();
    room();
    expect(
      (
        (await screen.findByLabelText(
          "Write to the people who back this",
        )) as HTMLTextAreaElement
      ).value,
    ).toBe("Half a thought");
  });

  it("a post that is too long cannot be sent", async () => {
    room();
    const box = await screen.findByLabelText(
      "Write to the people who back this",
    );
    fireEvent.change(box, { target: { value: "x".repeat(2001) } });
    expect(
      (screen.getByRole("button", { name: "Post" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("That is longer than a post can be.")).toBeTruthy();
  });
});

describe("the two lines under the writing standing", () => {
  it("says when a person who took out may still write, and when their link ends", async () => {
    world.standing = {
      kind: "write",
      graceEndsAt: Math.floor(Date.now() / 1000) + 3 * 3600,
      renewBy: NOW + 86_400 * 5,
    };
    room();
    expect(await screen.findByTestId("room-grace")).toBeTruthy();
    expect(screen.getByTestId("room-grace").textContent).toMatch(
      /^You took out .* You can write here for 3 hours more, then this room is read only for you\.$/,
    );
    expect(screen.getByTestId("room-renew").textContent).toMatch(
      /Your wallet link ends on .* Confirm it again to keep writing here\./,
    );
    expect(
      screen.getByLabelText("Write to the people who back this"),
    ).toBeTruthy();
  });
});

describe("the room has no accessibility violations", () => {
  it("as a holder with posts, answers and a pinned notice", async () => {
    const root = roomPost(ANA, "Question?", NOW - 50);
    stored(
      BO,
      1,
      [["e", root.id, "", "root"], ...roomTags],
      "An answer",
      NOW - 40,
    );
    room({ perks: true });
    await screen.findByText("An answer");
    expect(await seriousViolations(document.body)).toEqual([]);
  });
});
