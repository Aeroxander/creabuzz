// The saved posts as a person meets them: private, newest save first, and never a post the person would not see anywhere else;
// each state (empty, loading, a list that cannot be opened, posts that cannot be read) says what happened.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANA,
  BO,
  draw,
  hide,
  KEY,
  ME,
  NOW,
  nextId,
  note,
  profile,
  reset,
  sealed,
  stored,
  world,
} from "../safety/social-harness";
import { rememberReported } from "../safety/reported";

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

import { SavedPage } from "./SavedPage";

/** The person's list holding these posts, saved in this order (the last is the newest save). */
function save(...ids: string[]) {
  stored(
    world.me,
    10003,
    [],
    sealed(JSON.stringify(ids.map((id) => ["e", id]))),
    NOW - 10,
  );
}

beforeEach(() => {
  reset();
  world.me = nextId();
  profile(ANA, "Ana");
  profile(BO, "Bo");
});
afterEach(cleanup);

describe("the saved posts page", () => {
  it("lists the posts newest save first and says the list is private", async () => {
    const first = note(ANA, "First saved");
    const second = note(BO, "Second saved");
    save(first.id, second.id);
    draw(<SavedPage />);
    const list = await screen.findByTestId("saved-list");
    const cards = within(list).getAllByTestId("post-card");
    expect(cards[0].textContent).toContain("Second saved");
    expect(cards[1].textContent).toContain("First saved");
    expect(screen.getByText("Only you can see this list.")).toBeTruthy();
  });

  it("says nothing is saved yet, and how to save", async () => {
    draw(<SavedPage />);
    expect(await screen.findByTestId("saved-empty")).toBeTruthy();
    expect(
      screen.getByText("Press the bookmark under a post to keep it here."),
    ).toBeTruthy();
  });

  it("says the list cannot be opened (a locked passkey) and never that nothing is saved", async () => {
    save(note(ANA, "Kept").id);
    world.locked = true;
    draw(<SavedPage />);
    expect(await screen.findByTestId("saved-unreadable")).toBeTruthy();
    expect(screen.queryByTestId("saved-empty")).toBeNull();
    // Unlocked, Try again brings the posts.
    world.locked = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("saved-list")).toBeTruthy();
  });

  it("says the posts could not be read, with Try again, when the server did not answer", async () => {
    save(note(ANA, "Kept").id);
    world.failKinds = [1];
    draw(<SavedPage />);
    expect(await screen.findByTestId("saved-read-failed")).toBeTruthy();
    world.failKinds = [];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("saved-list")).toBeTruthy();
  });

  it("counts a saved post the server no longer has", async () => {
    save(note(ANA, "Still here").id, "9".repeat(64));
    draw(<SavedPage />);
    expect((await screen.findByTestId("saved-gone")).textContent).toMatch(
      /^1 saved post is no longer on this server/,
    );
    expect(screen.getByText("Still here")).toBeTruthy();
  });

  it("does not show a saved post by someone the person hid, or one they reported, and says how many", async () => {
    const kept = note(ANA, "Fine");
    const byHidden = note(BO, "By a hidden person");
    const reported = note(ANA, "A reported one");
    save(kept.id, byHidden.id, reported.id);
    hide(BO);
    rememberReported(world.me, reported.id);
    draw(<SavedPage />);
    const list = await screen.findByTestId("saved-list");
    expect(within(list).getAllByTestId("post-card")).toHaveLength(1);
    expect(screen.queryByText("By a hidden person")).toBeNull();
    expect(screen.queryByText("A reported one")).toBeNull();
    expect(screen.getByTestId("saved-hidden").textContent).toMatch(
      /^2 saved posts are not shown/,
    );
  });

  it("never shows a holder room's post saved from elsewhere", async () => {
    const inRoom = note(ANA, "Said in a room", NOW - 5, [
      ["a", `37001:${"f".repeat(64)}:x`],
      ["t", `room:${KEY}`],
    ]);
    save(inRoom.id);
    draw(<SavedPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("saved-loading")).toBeNull(),
    );
    expect(screen.queryByText("Said in a room")).toBeNull();
  });

  it("asks a signed-out person to make an account", async () => {
    world.signedIn = false;
    draw(<SavedPage />);
    expect(
      await screen.findByText("Sign in to see your saved posts"),
    ).toBeTruthy();
    expect(world.reads.some((f) => f.kinds?.includes(10003))).toBe(false);
  });

  it("reads each saved post once, by id, and no more than the newest hundred", async () => {
    const ids = Array.from(
      { length: 120 },
      (_, n) => note(ANA, `Post ${n}`, NOW - n - 1).id,
    );
    save(...ids);
    draw(<SavedPage />);
    await screen.findByTestId("saved-list");
    const read = world.reads.find((f) => Array.isArray(f.ids));
    expect((read?.ids as string[]).length).toBe(100);
    expect(
      screen.getByText("Showing your 100 newest saved posts."),
    ).toBeTruthy();
    void ME;
  });
});
