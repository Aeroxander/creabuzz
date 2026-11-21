// In a conversation, a comment by someone the reader hid (or one they reported) is folded into one quiet line with a press to look
// anyway, so the replies around it still make sense; nothing is folded for a reader who hid nobody.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberReported } from "../safety/reported";
import {
  ANA,
  BO,
  draw,
  hide,
  NOW,
  note,
  profile,
  reset,
  world,
} from "../safety/social-harness";
import type { Row } from "./use-posts";

const thread: { note: Row | null; ancestors: Row[]; replies: Row[] } = {
  note: null,
  ancestors: [],
  replies: [],
};
vi.mock("@creaton/core/social/thread-read.ts", () => ({
  fetchThread: async () => thread,
}));
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

import { PostPage } from "./PostPage";

const row = (
  event: ReturnType<typeof note>,
  replyToId: string | null,
): Row => ({
  event: event as Row["event"],
  replyToId,
  rootId: replyToId,
});

beforeEach(() => {
  reset();
  profile(ANA, "Ana");
  profile(BO, "Bo");
  const root = note(ANA, "The post", NOW - 100);
  thread.note = row(root, null);
  thread.ancestors = [];
  thread.replies = [];
});
afterEach(cleanup);

describe("a conversation and the people a reader hid", () => {
  it("draws no post until the hidden list has been read, so a hidden person's words never show for a moment", async () => {
    const root = thread.note as Row;
    thread.replies = [row(note(BO, "A rude comment", NOW - 50), root.event.id)];
    hide(BO);
    world.slow[10000] = 400;
    draw(<PostPage id={root.event.id} />);
    expect(
      (await screen.findAllByTestId("folded-wait")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("A rude comment")).toBeNull();
    expect(screen.queryByText("The post")).toBeNull();
    expect((await screen.findByTestId("folded-post")).textContent).toContain(
      "This is a post by someone you hid.",
    );
    expect(screen.queryByText("A rude comment")).toBeNull();
    expect(await screen.findByText("The post")).toBeTruthy();
  });

  it("folds a comment by a hidden person into one line and shows it on request", async () => {
    const root = thread.note as Row;
    thread.replies = [
      row(note(BO, "A rude comment", NOW - 50), root.event.id),
      row(note(ANA, "A kind comment", NOW - 40), root.event.id),
    ];
    hide(BO);
    draw(<PostPage id={root.event.id} />);
    expect(await screen.findByText("A kind comment")).toBeTruthy();
    const folded = await screen.findByTestId("folded-post");
    expect(folded.textContent).toContain("This is a post by someone you hid.");
    expect(screen.queryByText("A rude comment")).toBeNull();
    fireEvent.click(
      within(folded).getByRole("button", { name: "Show this post" }),
    );
    expect(await screen.findByText("A rude comment")).toBeTruthy();
  });

  it("folds a comment the reader reported, saying so", async () => {
    const root = thread.note as Row;
    const reply = note(BO, "Reported comment", NOW - 50);
    thread.replies = [row(reply, root.event.id)];
    rememberReported(world.me, reply.id);
    draw(<PostPage id={root.event.id} />);
    const folded = await screen.findByTestId("folded-post");
    expect(folded.textContent).toContain(
      "You reported this post. It is hidden for you.",
    );
    expect(screen.queryByText("Reported comment")).toBeNull();
  });

  it("folds the post itself when it is by a hidden person (a direct link), saying what it is", async () => {
    hide(ANA);
    draw(<PostPage id={(thread.note as Row).event.id} />);
    expect(await screen.findByTestId("folded-post")).toBeTruthy();
    expect(screen.queryByText("The post")).toBeNull();
  });

  it("folds nothing for a reader who hid nobody", async () => {
    const root = thread.note as Row;
    thread.replies = [row(note(BO, "A comment", NOW - 50), root.event.id)];
    draw(<PostPage id={root.event.id} />);
    expect(await screen.findByText("A comment")).toBeTruthy();
    expect(screen.queryByTestId("folded-post")).toBeNull();
  });
});
