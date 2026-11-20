// A holder room is read in its own tab and nowhere else: its posts are not in Home's recent posts, a person's profile posts
// or a project's updates, and what it holds is not counted as engagement on an ordinary post.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const FOUNDER = "f".repeat(64);
const KEY = `0x${"cd".repeat(32)}`;
const COORD = `37001:${FOUNDER}:lantern`;
const note = (id: string, tags: string[][] = [], kind = 1) => ({
  id: id.repeat(64).slice(0, 64),
  pubkey: "d".repeat(64),
  kind,
  created_at: 100,
  content: kind === 7 ? "+" : `text ${id}`,
  tags,
  sig: "0".repeat(128),
});
const ordinary = note("1", [["a", COORD]]);
const inRoom = note("2", [
  ["a", COORD],
  ["t", `room:${KEY}`],
]);
const likeInRoom = {
  ...note(
    "3",
    [
      ["e", ordinary.id],
      ["a", COORD],
      ["t", `room:${KEY}`],
    ],
    7,
  ),
  pubkey: "e".repeat(64),
};
const likeOutside = note("4", [["e", ordinary.id]], 7);

vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: null, locked: false }),
}));
vi.mock("../../lib/relay", () => ({
  read: async (filter: { kinds?: number[]; "#e"?: string[] }) =>
    filter["#e"] ? [likeInRoom, likeOutside] : [ordinary, inRoom],
  readMulti: async () => [[], [ordinary, inRoom]],
  publishAsUser: async () => undefined,
}));

import { parseProject } from "../project/project-record";
import { useProjectActivity } from "../project/use-project";
import { useEngagement, usePostsBy, useRecentPosts } from "./use-posts";

function wrap() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("the room is not in the other feeds", () => {
  it("is not in Home's recent posts or on a profile", async () => {
    const recent = renderHook(() => useRecentPosts(null), { wrapper: wrap() });
    await waitFor(() => expect(recent.result.current.data).toBeDefined());
    expect(recent.result.current.data?.map((e) => e.id)).toEqual([ordinary.id]);
    const by = renderHook(() => usePostsBy("d".repeat(64)), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(by.result.current.data).toBeDefined());
    expect(by.result.current.data?.map((e) => e.id)).toEqual([ordinary.id]);
  });

  it("is not in a project's updates", async () => {
    const project = parseProject({
      id: "9".repeat(64),
      pubkey: FOUNDER,
      kind: 37001,
      created_at: 50,
      content: "{}",
      tags: [
        ["d", "lantern"],
        ["name", "Lantern"],
      ],
    });
    const { result } = renderHook(() => useProjectActivity(project), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.updates.map((u) => u.id)).toEqual([
      ordinary.id,
    ]);
  });

  it("is not counted as a like on an ordinary post", async () => {
    const { result } = renderHook(() => useEngagement([ordinary.id]), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.get(ordinary.id)?.ups).toBe(1);
  });
});
