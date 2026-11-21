// Search as a person meets it: people, projects and posts by their words and a topic by its #; a post is never shown that a room,
// a hidden person or a report would hide; and each part says what happened (searching, nothing found, could not be searched).
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
  stored,
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

import { SearchPage } from "./SearchPage";

const FOUNDER = "f".repeat(64);
const project = (id: string, name: string, pitch: string) =>
  stored(
    FOUNDER,
    37001,
    [
      ["d", id],
      ["name", name],
    ],
    JSON.stringify({ pitch, stage: "draft", started: NOW - 100 }),
    NOW - 100,
  );

beforeEach(() => {
  reset();
  profile(ANA, "Ana Maker", "Makes solar lamps");
  profile(BO, "Bo Baker", "Bread");
});
afterEach(cleanup);

describe("search", () => {
  it("before anything is typed, says what to type and offers the topics people use", async () => {
    note(ANA, "Hello #lamps", NOW - 10, [["t", "lamps"]]);
    note(BO, "Also #lamps and #bread", NOW - 20);
    draw(<SearchPage q="" />);
    expect(screen.getByTestId("search-hint")).toBeTruthy();
    const topics = await screen.findByTestId("search-topics");
    const links = within(topics).getAllByRole("link");
    // The topic two people use comes first.
    expect(links[0].getAttribute("href")).toBe("/tag/lamps");
    expect(links.map((a) => a.getAttribute("href"))).toContain("/tag/bread");
  });

  it("says the topics could not be read, with Try again", async () => {
    world.failKinds = [1];
    draw(<SearchPage q="" />);
    expect(await screen.findByTestId("search-topics-failed")).toBeTruthy();
    expect(screen.queryByTestId("search-topics-none")).toBeNull();
  });

  it("finds people by name or line and projects by name or line, and says when there are none", async () => {
    project("lantern", "Lantern", "Solar lamps for night markets");
    draw(<SearchPage q="solar" />);
    const people = await screen.findByTestId("search-people");
    expect(within(people).getByText("Ana Maker")).toBeTruthy();
    expect(within(people).queryByText("Bo Baker")).toBeNull();
    const projects = await screen.findByTestId("search-projects");
    expect(within(projects).getByText("Lantern")).toBeTruthy();
    cleanup();
    draw(<SearchPage q="zebra" />);
    expect(await screen.findByTestId("search-people-none")).toBeTruthy();
    expect(await screen.findByTestId("search-projects-none")).toBeTruthy();
    expect(await screen.findByTestId("search-posts-none")).toBeTruthy();
  });

  it("finds a post by its words on a server whose index holds only profiles", async () => {
    world.indexed = [0];
    note(ANA, "Lit the first lamp today", NOW - 10);
    note(BO, "Bread is ready", NOW - 20);
    draw(<SearchPage q="lamp" />);
    const list = await screen.findByTestId("search-posts");
    expect(within(list).getAllByTestId("post-card")).toHaveLength(1);
    // Profiles were asked of the server's index; posts were looked through, and the server's index was asked as well.
    expect(world.searches.length).toBeGreaterThanOrEqual(2);
  });

  it("lists a post that both ways found once", async () => {
    note(ANA, "Lit the first lamp today", NOW - 10);
    draw(<SearchPage q="lamp" />);
    const list = await screen.findByTestId("search-posts");
    expect(within(list).getAllByTestId("post-card")).toHaveLength(1);
  });

  it("never shows a post a room keeps, a hidden person's, or a reported one, and says how many it left out", async () => {
    note(ANA, "Shown lamp", NOW - 10);
    note(ANA, "Lamp in a room", NOW - 11, [
      ["a", `37001:${FOUNDER}:x`],
      ["t", `room:${KEY}`],
    ]);
    note(BO, "Lamp by a hidden person", NOW - 12);
    const reported = note(ANA, "Reported lamp", NOW - 13);
    hide(BO);
    rememberReported(world.me, reported.id);
    draw(<SearchPage q="lamp" />);
    const list = await screen.findByTestId("search-posts");
    expect(within(list).getAllByTestId("post-card")).toHaveLength(1);
    expect(screen.queryByText(/Lamp in a room/)).toBeNull();
    expect(screen.queryByText(/hidden person/)).toBeNull();
    expect(screen.queryByText(/Reported lamp/)).toBeNull();
    expect(screen.getByTestId("search-posts-hidden").textContent).toMatch(
      /^2 posts are not shown/,
    );
  });

  it("does not offer a hidden person among the people", async () => {
    hide(ANA);
    draw(<SearchPage q="maker" />);
    expect(await screen.findByTestId("search-people-none")).toBeTruthy();
    expect(screen.queryByText("Ana Maker")).toBeNull();
  });

  it("says each part could not be searched, with Try again, and keeps what did work", async () => {
    note(ANA, "Lamp post", NOW - 10);
    world.failKinds = [0];
    draw(<SearchPage q="lamp" />);
    expect(await screen.findByTestId("search-people-failed")).toBeTruthy();
    expect(await screen.findByTestId("search-posts")).toBeTruthy();
    world.failKinds = [];
    fireEvent.click(
      within(screen.getByTestId("search-people-failed")).getByRole("button", {
        name: "Try again",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("search-people-failed")).toBeNull(),
    );
  });

  it("says older posts could not be searched when only the server's search failed, and shows what the newest posts hold", async () => {
    note(ANA, "Lamp post", NOW - 10);
    world.failSearch = true;
    draw(<SearchPage q="lamp" />);
    expect(await screen.findByTestId("search-posts-partly")).toBeTruthy();
    // The scan still answered for the posts.
    expect(
      within(await screen.findByTestId("search-posts")).getAllByTestId(
        "post-card",
      ),
    ).toHaveLength(1);
  });

  it("says posts could not be searched when nothing answered, never that none were found", async () => {
    world.failKinds = [1];
    draw(<SearchPage q="lamp" />);
    expect(await screen.findByTestId("search-posts-failed")).toBeTruthy();
    expect(screen.queryByTestId("search-posts-none")).toBeNull();
  });

  it("says projects could not be read, with Try again", async () => {
    world.failKinds = [37001];
    draw(<SearchPage q="lamp" />);
    expect(await screen.findByTestId("search-projects-failed")).toBeTruthy();
  });

  it("turns a #word into a link to the topic and searches nothing", async () => {
    draw(<SearchPage q="#Lamps" />);
    const link = await screen.findByTestId("search-topic-link");
    expect(link.getAttribute("href")).toBe("/tag/lamps");
    expect(world.reads).toHaveLength(0);
  });

  it("asks nobody for fewer than two letters and says so as the person types", async () => {
    draw(<SearchPage q="" />);
    const box = screen.getByLabelText("Search");
    fireEvent.change(box, { target: { value: "a" } });
    expect(screen.getByText("Type at least two letters.")).toBeTruthy();
    expect(world.searches).toHaveLength(0);
  });

  it("keeps what is typed in the address after a pause, and at once on Enter", async () => {
    draw(<SearchPage q="" />);
    const box = screen.getByLabelText("Search");
    fireEvent.change(box, { target: { value: "lamp" } });
    expect(world.navigated).toHaveLength(0);
    await waitFor(() => expect(world.navigated).toHaveLength(1));
    expect(world.navigated[0]).toMatchObject({
      to: "/search",
      search: { q: "lamp" },
      replace: true,
    });
    fireEvent.change(box, { target: { value: "lamps" } });
    fireEvent.submit(box.closest("form") as HTMLFormElement);
    expect(world.navigated.at(-1)).toMatchObject({ search: { q: "lamps" } });
  });
});
