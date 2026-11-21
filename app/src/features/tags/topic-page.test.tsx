// The page of one topic: the posts under it, newest first, and never a post the reader would not see elsewhere (a holder room's, a
// hidden person's, a reported one); each state says what happened.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberReported } from "../safety/reported";
import {
  ANA,
  BO,
  draw,
  hide,
  KEY,
  NOW,
  note,
  profile,
  reset,
  world,
} from "../safety/social-harness";

vi.mock(
  "../../lib/relay",
  async () => (await import("../safety/social-harness")).relayMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("../safety/social-harness")).accountMock,
);
vi.mock(
  "@creaton/core/client/identity.ts",
  async () => (await import("../safety/social-harness")).identityMock,
);
vi.mock("@tanstack/react-router", async (actual) =>
  (await import("../safety/social-harness")).routerMock(actual),
);

import { TopicPage } from "./TopicPage";

const ROOM = [
  ["a", `37001:${"f".repeat(64)}:x`],
  ["t", `room:${KEY}`],
  ["t", "lamps"],
];

beforeEach(() => {
  reset();
  profile(ANA, "Ana");
  profile(BO, "Bo");
});
afterEach(cleanup);

describe("a topic's page", () => {
  it("lists the posts under the topic, newest first, and asks the server by the topic's tag", async () => {
    note(ANA, "Older #lamps", NOW - 50, [["t", "lamps"]]);
    note(BO, "Newer #lamps", NOW - 10, [["t", "lamps"]]);
    note(BO, "Another #seeds", NOW - 5, [["t", "seeds"]]);
    draw(<TopicPage tag="Lamps" />);
    const list = await screen.findByTestId("topic-list");
    const cards = within(list).getAllByTestId("post-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Newer");
    expect(
      world.reads.some(
        (f) => (f["#t"] as string[] | undefined)?.[0] === "lamps",
      ),
    ).toBe(true);
  });

  it("does not show a holder room's post, even one that carries the topic", async () => {
    note(ANA, "In a room #lamps", NOW - 10, ROOM);
    note(BO, "In the open #lamps", NOW - 20, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    const list = await screen.findByTestId("topic-list");
    expect(within(list).getAllByTestId("post-card")).toHaveLength(1);
    expect(screen.queryByText(/In a room/)).toBeNull();
  });

  it("does not show a person the reader hid, nor a post they reported, and says how many", async () => {
    note(ANA, "Kept #lamps", NOW - 10, [["t", "lamps"]]);
    note(BO, "By a hidden person #lamps", NOW - 20, [["t", "lamps"]]);
    const reported = note(ANA, "Reported one #lamps", NOW - 30, [
      ["t", "lamps"],
    ]);
    hide(BO);
    rememberReported(world.me, reported.id);
    draw(<TopicPage tag="lamps" />);
    const list = await screen.findByTestId("topic-list");
    expect(within(list).getAllByTestId("post-card")).toHaveLength(1);
    expect(screen.queryByText(/By a hidden person/)).toBeNull();
    expect(screen.queryByText(/Reported one/)).toBeNull();
    expect(screen.getByTestId("topic-hidden").textContent).toMatch(
      /^2 posts are not shown/,
    );
  });

  it("says so when every post under the topic is hidden for the reader, not that the topic is empty", async () => {
    note(BO, "Only by a hidden person #lamps", NOW - 20, [["t", "lamps"]]);
    hide(BO);
    draw(<TopicPage tag="lamps" />);
    const note_ = await screen.findByTestId("topic-all-hidden");
    expect(note_.textContent).toContain("hidden for you");
    expect(screen.queryByTestId("topic-empty")).toBeNull();
  });

  it("says no post has the topic yet", async () => {
    draw(<TopicPage tag="lamps" />);
    expect((await screen.findByTestId("topic-empty")).textContent).toContain(
      "No posts under #lamps yet",
    );
  });

  it("says the topic could not be read, with Try again", async () => {
    world.failKinds = [1];
    draw(<TopicPage tag="lamps" />);
    expect(await screen.findByTestId("topic-failed")).toBeTruthy();
    world.failKinds = [];
    note(ANA, "Back #lamps", NOW - 10, [["t", "lamps"]]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("topic-list")).toBeTruthy();
  });

  it("says what a topic is for an address that is not one, and reads nothing", async () => {
    draw(<TopicPage tag="a" />);
    expect(await screen.findByTestId("topic-bad")).toBeTruthy();
    expect(world.reads).toHaveLength(0);
  });

  it("waits for the hidden list before it draws any post, so a hidden person never shows for a moment", async () => {
    note(BO, "By a hidden person #lamps", NOW - 20, [["t", "lamps"]]);
    note(ANA, "Fine #lamps", NOW - 30, [["t", "lamps"]]);
    hide(BO);
    // The posts arrive at once; the hidden list a good while later.
    world.slow = { 10000: 250 };
    draw(<TopicPage tag="lamps" />);
    await waitFor(() => expect(world.reads.some((f) => f["#t"])).toBe(true));
    await new Promise((r) => setTimeout(r, 120));
    // The posts are in, the list is not: nothing is drawn yet, least of all the hidden person's post.
    expect(screen.queryByText(/By a hidden person/)).toBeNull();
    expect(screen.queryByTestId("topic-list")).toBeNull();
    expect(screen.getByTestId("topic-loading")).toBeTruthy();
    expect(await screen.findByTestId("topic-list")).toBeTruthy();
    expect(screen.queryByText(/By a hidden person/)).toBeNull();
    expect(screen.getByText(/Fine/)).toBeTruthy();
  });
});
