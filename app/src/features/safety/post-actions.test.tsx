// What a post's More press offers beyond report and hide, and the pictures a post shows: reposting and taking a repost back,
// quoting, editing and deleting one's own post (with what deleting can and cannot do said first), hiding a post's pictures,
// and drawing only pictures kept on this server.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAllHiddenPictures } from "../pictures/hidden-pictures";
import {
  ANA,
  draw,
  NOW,
  note,
  profile,
  reset,
  stored,
  world,
} from "./social-harness";

const thread: { note: unknown; replies: unknown[] } = {
  note: null,
  replies: [],
};
vi.mock("@creaton/core/social/thread-read.ts", () => ({
  fetchThread: async () => ({
    note: thread.note,
    ancestors: [],
    replies: thread.replies,
  }),
}));
vi.mock(
  "../../lib/relay",
  async () => (await import("./social-harness")).relayMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("./social-harness")).accountMock,
);
vi.mock(
  "@creaton/core/client/identity.ts",
  async () => (await import("./social-harness")).identityMock,
);
vi.mock("@tanstack/react-router", async (actual) =>
  (await import("./social-harness")).routerMock(actual),
);

import { PostPage } from "../posts/PostPage";
import { TopicPage } from "../tags/TopicPage";

const fetchCalls: string[] = [];
beforeEach(() => {
  reset();
  forgetAllHiddenPictures();
  fetchCalls.length = 0;
  profile(ANA, "Ana");
  URL.createObjectURL = () => "blob:picture";
  URL.revokeObjectURL = () => undefined;
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    fetchCalls.push(String(url));
    return new Response(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
      {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      },
    );
  }) as typeof fetch;
});
afterEach(cleanup);

const moreOf = async (name: string) =>
  (
    await screen.findAllByRole("button", {
      name: `More actions for ${name}'s post`,
    })
  )[0];
const menu = () => screen.findByTestId("post-menu");

describe("someone else's post", () => {
  it("offers Repost and Quote, and a repost is the post shared as it is", async () => {
    const post = note(ANA, "Lit #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOf("Ana"));
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Repost" }),
    );
    await waitFor(() => expect(world.published).toHaveLength(1));
    const repost = world.published[0];
    expect(repost.kind).toBe(6);
    expect(repost.tags).toEqual([
      ["e", post.id],
      ["p", ANA],
    ]);
    expect(JSON.parse(repost.content).id).toBe(post.id);
    expect(
      await screen.findByText("Reposted to the people who follow you"),
    ).toBeTruthy();
  });

  it("takes a repost back with a deletion of the repost, not of the post", async () => {
    const post = note(ANA, "Lit #lamps", NOW - 10, [["t", "lamps"]]);
    const repost = stored(
      world.me,
      6,
      [
        ["e", post.id],
        ["p", ANA],
      ],
      JSON.stringify(post),
      NOW - 5,
    );
    draw(<TopicPage tag="lamps" />);
    // The engagement read finds the person's own repost: the press now takes it back.
    await waitFor(async () => {
      fireEvent.click(await moreOf("Ana"));
      expect(
        within(await menu()).queryByRole("button", { name: "Undo repost" }),
      ).toBeTruthy();
    });
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Undo repost" }),
    );
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(world.published[0].kind).toBe(5);
    expect(world.published[0].tags).toEqual([
      ["e", repost.id],
      ["k", "6"],
    ]);
  });

  it("a signed-out person is sent to make an account instead of reposting", async () => {
    world.signedIn = false;
    note(ANA, "Lit #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOf("Ana"));
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Repost" }),
    );
    await waitFor(() => expect(world.navigated.length).toBeGreaterThan(0));
    expect(world.published).toHaveLength(0);
  });

  it("opens the writing box to quote, over the quoted post", async () => {
    note(ANA, "Lit #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOf("Ana"));
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Quote" }),
    );
    const sheet = await screen.findByTestId("composer");
    expect(
      within(sheet).getByRole("heading", { name: "Quote this post" }),
    ).toBeTruthy();
    expect(await within(sheet).findByTestId("quoted-post")).toBeTruthy();
  });
});

describe("the viewer's own post", () => {
  it("is deleted only after what deleting can and cannot do has been said, and deleting is a deletion of that post", async () => {
    const mine = note(world.me, "Mine #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOf("Someone"));
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Delete" }),
    );
    const dialog = await screen.findByTestId("delete-dialog");
    expect(dialog.textContent).toMatch(/takes your post off this server/);
    expect(dialog.textContent).toMatch(/cannot take back copies/);
    expect(dialog.textContent).toMatch(
      /Pictures in it may stay stored on this server/,
    );
    expect(world.published).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep post" }));
    await waitFor(() =>
      expect(screen.queryByTestId("delete-dialog")).toBeNull(),
    );
    expect(world.published).toHaveLength(0);
    fireEvent.click(await moreOf("Someone"));
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Delete" }),
    );
    fireEvent.click(
      within(await screen.findByTestId("delete-dialog")).getByTestId(
        "delete-confirm",
      ),
    );
    await waitFor(() => expect(world.published).toHaveLength(1));
    expect(world.published[0].kind).toBe(5);
    expect(world.published[0].tags).toEqual([
      ["e", mine.id],
      ["k", "1"],
    ]);
    expect(await screen.findByText("Post deleted")).toBeTruthy();
  });

  it("a deletion the server refuses is said, and the post stays", async () => {
    note(world.me, "Mine #lamps", NOW - 10, [["t", "lamps"]]);
    world.refuse = "restricted: not now";
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOf("Someone"));
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Delete" }),
    );
    fireEvent.click(
      within(await screen.findByTestId("delete-dialog")).getByTestId(
        "delete-confirm",
      ),
    );
    expect(
      await screen.findByText(/restricted: not now|was not deleted/),
    ).toBeTruthy();
    expect(screen.getByTestId("post-card")).toBeTruthy();
  });

  it("can be edited while nobody has commented, and not after, with the reason", async () => {
    const mine = note(world.me, "Mine #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOf("Someone"));
    expect(
      (
        within(await menu()).getByRole("button", {
          name: "Edit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    cleanup();
    reset();
    profile(ANA, "Ana");
    const other = note(world.me, "Mine #lamps", NOW - 10, [["t", "lamps"]]);
    note(ANA, "A comment", NOW - 5, [
      ["e", other.id, "", "root"],
      ["t", "lamps"],
    ]);
    expect(mine.id).not.toBe(other.id);
    draw(<TopicPage tag="lamps" />);
    const card = (await screen.findByText("Mine")).closest(
      "article",
    ) as HTMLElement;
    // The comment is counted once the counts have been read.
    await within(card).findByRole("link", {
      name: "Comments on Someone's post, 1",
    });
    fireEvent.click(
      within(card).getByRole("button", {
        name: "More actions for Someone's post",
      }),
    );
    expect(
      (
        within(await menu()).getByRole("button", {
          name: "Edit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect((await menu()).textContent).toMatch(
      /comments on this one would be left behind/,
    );
  });

  it("offers no Edit on a comment, only Delete", async () => {
    const root = note(ANA, "Root", NOW - 50);
    const comment = note(world.me, "My comment", NOW - 10, [
      ["e", root.id, "", "root"],
    ]);
    thread.note = { event: root as never, replyToId: null, rootId: null };
    thread.replies = [
      { event: comment as never, replyToId: root.id, rootId: root.id },
    ];
    draw(<PostPage id={root.id} />);
    const mineCard = (await screen.findByText("My comment")).closest(
      "article",
    ) as HTMLElement;
    fireEvent.click(
      await within(mineCard).findByRole("button", { name: /More actions/ }),
    );
    const items = within(await menu())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(items).toContain("Delete");
    expect(items).not.toContain("Edit");
  });
});

const url = (c: string) => `http://localhost:3000/media/${c.repeat(64)}.jpg`;

describe("a post's pictures", () => {
  it("draws a picture kept on this server with its description, fetched with a signed read", async () => {
    note(ANA, `Lit #lamps\n${url("a")}`, NOW - 10, [
      ["t", "lamps"],
      ["imeta", `url ${url("a")}`, "alt A red lamp"],
    ]);
    draw(<TopicPage tag="lamps" />);
    const img = await screen.findByTestId("post-picture");
    expect(img.getAttribute("alt")).toBe("A red lamp");
    // The address is not shown as text under the words.
    expect(screen.getByTestId("post-card").textContent).not.toContain(
      "/media/",
    );
    expect(fetchCalls).toEqual([url("a")]);
  });

  it("names a picture with no description as having none", async () => {
    note(ANA, `Lit #lamps\n${url("a")}`, NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    expect(
      (await screen.findByTestId("post-picture")).getAttribute("alt"),
    ).toBe("Picture (no description)");
  });

  it("never asks another website for a picture", async () => {
    note(ANA, "Look #lamps\nhttps://tracker.test/pixel.png", NOW - 10, [
      ["t", "lamps"],
      ["imeta", "url https://tracker.test/pixel.png", "alt tracking"],
    ]);
    draw(<TopicPage tag="lamps" />);
    await screen.findByTestId("post-card");
    expect(screen.queryByTestId("post-picture")).toBeNull();
    expect(screen.queryByTestId("post-pictures")).toBeNull();
    expect(fetchCalls).toEqual([]);
  });

  it("a picture the server will not hand over says so in words, and the post's words stay", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("no", { status: 403 }),
    ) as typeof fetch;
    note(ANA, `Lit #lamps\n${url("b")}`, NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    expect(
      (await screen.findByTestId("post-picture-unavailable")).textContent,
    ).toBe("Picture can't be shown");
    expect(screen.getByTestId("post-card").textContent).toContain("Lit #lamps");
  });

  it("can be hidden from More, shows covered, and one press shows it again", async () => {
    note(ANA, `Lit #lamps\n${url("c")}`, NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    await screen.findByTestId("post-picture");
    fireEvent.click(await moreOf("Ana"));
    fireEvent.click(
      within(await menu()).getByRole("button", { name: "Hide the picture" }),
    );
    const covered = await screen.findByTestId("post-picture-hidden");
    expect(screen.queryByTestId("post-picture")).toBeNull();
    // The post and its words are still there.
    expect(screen.getByTestId("post-card").textContent).toContain("Lit #lamps");
    expect(localStorage.getItem(`creaton.hiddenpics.${world.me}`)).toContain(
      "c".repeat(64),
    );
    fireEvent.click(covered);
    expect(await screen.findByTestId("post-picture")).toBeTruthy();
    expect(
      localStorage.getItem(`creaton.hiddenpics.${world.me}`),
    ).not.toContain("c".repeat(64));
  });

  it("offers Hide the picture only on a post that has one", async () => {
    note(ANA, "Plain #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOf("Ana"));
    expect(
      within(await menu()).queryByRole("button", { name: /Hide the picture/ }),
    ).toBeNull();
  });
});

describe("a quote of a post", () => {
  it("shows the quoted post under the words, and a quote of a post that is gone says so", async () => {
    const quoted = note(ANA, "Original words", NOW - 100);
    note(ANA, "Agreed #lamps\n\nnostr:nevent1x", NOW - 10, [
      ["t", "lamps"],
      ["q", quoted.id, "", ANA],
    ]);
    draw(<TopicPage tag="lamps" />);
    const card = await screen.findByTestId("quoted-post");
    expect(card.textContent).toContain("Original words");
    cleanup();
    reset();
    profile(ANA, "Ana");
    note(ANA, "Agreed #lamps", NOW - 10, [
      ["t", "lamps"],
      ["q", "e".repeat(64), "", ANA],
    ]);
    draw(<TopicPage tag="lamps" />);
    await waitFor(() =>
      expect(screen.getByTestId("quoted-post-missing").textContent).toBe(
        "This post was removed.",
      ),
    );
  });

  it("does not show a quoted post by someone the reader hid", async () => {
    const quoted = note(ANA, "Original words", NOW - 100);
    const { hide } = await import("./social-harness");
    hide(ANA);
    note(world.me, "Agreed #lamps", NOW - 10, [
      ["t", "lamps"],
      ["q", quoted.id, "", ANA],
    ]);
    draw(<TopicPage tag="lamps" />);
    await waitFor(() =>
      expect(screen.getByTestId("quoted-post-missing").textContent).toBe(
        "You hid this post.",
      ),
    );
    expect(screen.queryByText("Original words")).toBeNull();
  });
});
