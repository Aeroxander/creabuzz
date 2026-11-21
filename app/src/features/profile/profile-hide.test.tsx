// A profile: hiding the person is one press (kept in the private list, never told to them), their posts are then not shown, a way
// back is one press, and a post the reader reported is left out of the list.
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
  draw,
  hide,
  NOW,
  note,
  profile,
  reset,
  unsealed,
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

import { ProfilePage } from "./ProfilePage";

beforeEach(() => {
  reset();
  profile(ANA, "Ana");
});
afterEach(cleanup);

describe("a profile and hiding the person", () => {
  it("hides the person in one press, takes their posts away and says only the reader stops seeing them", async () => {
    note(ANA, "Ana's post", NOW - 10);
    draw(<ProfilePage pubkey={ANA} />);
    expect(await screen.findByText("Ana's post")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Hide Ana's posts" }),
    );
    expect(await screen.findByTestId("profile-hidden-note")).toBeTruthy();
    expect(screen.queryByText("Ana's post")).toBeNull();
    const list = world.published.find((e) => e.kind === 10000);
    expect(
      (JSON.parse(unsealed(list?.content ?? "")) as string[][]).map(
        (t) => t[1],
      ),
    ).toEqual([ANA]);
    expect(list?.tags).toEqual([]);
    // One press back.
    fireEvent.click(
      await screen.findByRole("button", { name: "Show Ana's posts again" }),
    );
    expect(await screen.findByText("Ana's post")).toBeTruthy();
  });

  it("shows a person already hidden as hidden, with no posts, before anything is pressed", async () => {
    note(ANA, "Ana's post", NOW - 10);
    hide(ANA);
    draw(<ProfilePage pubkey={ANA} />);
    expect(await screen.findByTestId("profile-hidden-note")).toBeTruthy();
    expect(screen.queryByText("Ana's post")).toBeNull();
  });

  it("leaves out a post the reader reported and says why when that was all there was", async () => {
    const post = note(ANA, "Reported post", NOW - 10);
    rememberReported(world.me, post.id);
    draw(<ProfilePage pubkey={ANA} />);
    expect(
      await screen.findByText(/Their posts are hidden for you/),
    ).toBeTruthy();
    expect(screen.queryByText("Reported post")).toBeNull();
  });

  it("says the posts could not be read, not that there are none", async () => {
    world.failKinds = [1];
    draw(<ProfilePage pubkey={ANA} />);
    expect(
      await screen.findByText("Their posts could not be read right now."),
    ).toBeTruthy();
    expect(screen.queryByText("No posts yet.")).toBeNull();
  });

  it("offers no hide on a person's own profile", async () => {
    draw(<ProfilePage pubkey={world.me} />);
    await screen.findByTestId("profile-page");
    expect(screen.queryByTestId("profile-hide")).toBeNull();
    void within;
    void waitFor;
  });
});
