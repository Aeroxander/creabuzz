// A post that another post quotes follows the same hiding rule as every list, and never flashes: until the hidden list has
// been read, the quote shows "loading", not the quoted words, so a post by someone the reader hid is never drawn and then taken away.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { QuotedPost } from "./QuotedPost";
import { QUOTED_HIDDEN, QUOTED_LOADING } from "./post-words";

beforeEach(() => {
  reset();
  profile(ANA, "Ana");
  profile(BO, "Bo");
});
afterEach(cleanup);

const quotedRead = (id: string) =>
  world.reads.some(
    (f) => Array.isArray(f.ids) && (f.ids as string[]).includes(id),
  );

describe("a quoted post and the people a reader hid", () => {
  it("shows no words of a quoted post by a hidden person, not even before the hidden list has been read", async () => {
    const quoted = note(BO, "A rude quoted post", NOW - 50);
    hide(BO);
    // The hidden list arrives late; the quoted post itself arrives at once.
    world.slow[10000] = 600;
    draw(<QuotedPost id={quoted.id} />);
    // The quoted post has been read, and the hidden list has not: the card says it is loading and shows nothing of the post.
    await vi.waitFor(() => expect(quotedRead(quoted.id)).toBe(true));
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByText("A rude quoted post")).toBeNull();
    expect(screen.queryByTestId("quoted-post")).toBeNull();
    expect((await screen.findByTestId("quoted-post-missing")).textContent).toBe(
      QUOTED_LOADING,
    );
    // Once the list is read the same card says the post is hidden, and the words never showed.
    await vi.waitFor(() =>
      expect(screen.getByTestId("quoted-post-missing").textContent).toBe(
        QUOTED_HIDDEN,
      ),
    );
    expect(screen.queryByText("A rude quoted post")).toBeNull();
  });

  it("shows the quoted post of someone the reader did not hide, once the hidden list has been read", async () => {
    const quoted = note(ANA, "A kind quoted post", NOW - 50);
    draw(<QuotedPost id={quoted.id} />);
    expect(await screen.findByText("A kind quoted post")).toBeTruthy();
    expect(screen.queryByTestId("quoted-post-missing")).toBeNull();
  });
});
