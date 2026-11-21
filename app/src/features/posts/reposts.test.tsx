// Reposts on Home: a repost shows the post with who shared it, once; a repost of a post its author deleted is not shown whatever
// copy the repost carries; a repost of a reply or a room post is left out; and someone the reader hid has no reposts shown.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANA,
  BO,
  hide,
  NOW,
  note,
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

import { useVisibleRows } from "../safety/use-hidden";
import { feedRows, useReposts } from "./use-posts";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

beforeEach(reset);

const repostOf = (by: string, post: ReturnType<typeof note>, at: number) =>
  stored(
    by,
    6,
    [
      ["e", post.id],
      ["p", post.pubkey],
    ],
    JSON.stringify(post),
    at,
  );

async function rows(authors: string[] | null = null) {
  const posts = world.events.filter(
    (e) => e.kind === 1 && (!authors || authors.includes(e.pubkey)),
  );
  const reposts = renderHook(() => useReposts(authors), { wrapper });
  await waitFor(() => expect(reposts.result.current.data).toBeDefined());
  return feedRows(posts, reposts.result.current.data);
}

describe("reposts in the feed", () => {
  it("shows the shared post once, with who shared it, ordered by when it was shared", async () => {
    const old = note(BO, "An older post", NOW - 1000);
    note(ANA, "A newer post", NOW - 100);
    repostOf(ANA, old, NOW - 10);
    const list = await rows();
    expect(list.map((r) => r.event.content)).toEqual([
      "An older post",
      "A newer post",
    ]);
    expect(list[0].repostedBy).toEqual({ pubkey: ANA, at: NOW - 10 });
    expect(list[1].repostedBy).toBeUndefined();
  });

  it("a post that is both posted and reposted appears once, at its newest", async () => {
    const post = note(ANA, "Once", NOW - 1000);
    repostOf(BO, post, NOW - 10);
    const list = await rows();
    expect(list).toHaveLength(1);
    expect(list[0].repostedBy?.pubkey).toBe(BO);
  });

  it("a repost of a post its author deleted is not shown, whatever copy the repost carries", async () => {
    const post = note(BO, "Deleted soon", NOW - 1000);
    repostOf(ANA, post, NOW - 10);
    // The server no longer has the post.
    world.events = world.events.filter((e) => e.id !== post.id);
    expect(await rows()).toEqual([]);
  });

  it("leaves out a repost of a reply or of a room's post", async () => {
    const root = note(BO, "Root", NOW - 2000);
    const reply = note(BO, "Reply", NOW - 1000, [["e", root.id, "", "root"]]);
    const inRoom = note(BO, "Room", NOW - 900, [
      ["a", `37001:${BO}:x`],
      ["t", `room:0x${"cd".repeat(32)}`],
    ]);
    repostOf(ANA, reply, NOW - 10);
    repostOf(ANA, inRoom, NOW - 9);
    const list = await rows();
    expect(list.map((r) => r.event.content)).toEqual(["Root"]);
  });

  it("reads only the reposts of the people asked for", async () => {
    const post = note("4".repeat(64), "Shared", NOW - 1000);
    repostOf(ANA, post, NOW - 10);
    expect(await rows([BO])).toEqual([]);
    expect((await rows([ANA])).map((r) => r.event.content)).toEqual(["Shared"]);
  });
});

describe("what the reader hid", () => {
  it("hides a repost by someone the reader hid, and a repost of a hidden person's post", async () => {
    const byBo = note(BO, "Bo wrote this", NOW - 1000);
    const byFay = note("4".repeat(64), "Fay wrote this", NOW - 900);
    repostOf(ANA, byBo, NOW - 10);
    repostOf(BO, byFay, NOW - 9);
    hide(BO);
    const list = await rows();
    const view = renderHook(() => useVisibleRows(list), { wrapper });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    // Bo's own post (shared by Ana) is hidden; Fay's post shared by Bo is hidden because Bo is.
    expect(view.result.current.shown).toEqual([]);
  });
});
