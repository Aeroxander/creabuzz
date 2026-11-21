// Saving a post: the post is kept in the private part of the person's list, beside what else the list holds (the projects they
// follow, other apps' entries); a list that cannot be opened is a failure and never an empty list, and nothing is written over it;
// and a save and a follow made together both survive (the list replaces itself on each write, so changes go one at a time).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountMock,
  identityMock,
  NOW,
  nextId,
  relayMock,
  reset,
  sealed,
  stored,
  unsealed,
  world,
} from "../features/safety/social-harness";

vi.mock(
  "./relay",
  async () => (await import("../features/safety/social-harness")).relayMock,
);
vi.mock(
  "./account",
  async () => (await import("../features/safety/social-harness")).accountMock,
);
vi.mock(
  "@creaton/core/client/identity.ts",
  async () => (await import("../features/safety/social-harness")).identityMock,
);

import {
  MAX_SAVED,
  SAVED_FULL,
  SAVED_UNREADABLE,
  useBookmarks,
} from "./bookmarks";
import { useFollowProject } from "./follows";

const POST_A = "a".repeat(64);
const POST_B = "b".repeat(64);
const POST_C = "c".repeat(64);
const COORD = `37001:${"f".repeat(64)}:lantern`;

function hooks() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => ({ saved: useBookmarks(), follow: useFollowProject() }),
    { wrapper },
  );
}

const lastList = () => world.published.filter((e) => e.kind === 10003).at(-1);
const privateIds = () =>
  (JSON.parse(unsealed(lastList()?.content ?? "")) as string[][]).map(
    (t) => t[1],
  );

beforeEach(() => {
  reset();
  // The list queue remembers what this page last wrote for a person; each test is a different person.
  world.me = nextId();
});
void accountMock;
void identityMock;
void relayMock;

describe("saving posts", () => {
  it("keeps a saved post in the private part of the list and never in a public tag", async () => {
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.ready).toBe(true));
    await act(() => result.current.saved.save(POST_A));
    expect(lastList()?.kind).toBe(10003);
    expect(privateIds()).toEqual([POST_A]);
    expect(lastList()?.tags.some((t) => t[0] === "e")).toBe(false);
    expect(JSON.stringify(lastList()?.tags)).not.toContain(POST_A);
    await waitFor(() =>
      expect(result.current.saved.isSaved(POST_A)).toBe(true),
    );
  });

  it("lists the newest save first and takes a post out again", async () => {
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.ready).toBe(true));
    await act(() => result.current.saved.save(POST_A));
    await act(() => result.current.saved.save(POST_B));
    await waitFor(() =>
      expect(result.current.saved.ids).toEqual([POST_B, POST_A]),
    );
    await act(() => result.current.saved.remove(POST_B));
    expect(privateIds()).toEqual([POST_A]);
    await waitFor(() => expect(result.current.saved.ids).toEqual([POST_A]));
    expect(result.current.saved.isSaved(POST_B)).toBe(false);
  });

  it("keeps the projects followed and another app's entries when it saves", async () => {
    stored(
      world.me,
      10003,
      [
        ["a", COORD],
        ["e", POST_C],
        ["t", "keep"],
      ],
      "",
      NOW - 50,
    );
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.ready).toBe(true));
    // Another app's public entry is a saved post too.
    expect(result.current.saved.ids).toEqual([POST_C]);
    await act(() => result.current.saved.save(POST_A));
    const tags = lastList()?.tags ?? [];
    expect(tags).toContainEqual(["a", COORD]);
    expect(tags).toContainEqual(["t", "keep"]);
    expect(privateIds()).toEqual([POST_A]);
  });

  it("is read back from a list another device saved", async () => {
    stored(
      world.me,
      10003,
      [],
      sealed(
        JSON.stringify([
          ["e", POST_A],
          ["e", POST_B],
        ]),
      ),
      NOW - 50,
    );
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.ready).toBe(true));
    expect(result.current.saved.ids).toEqual([POST_B, POST_A]);
  });

  it("says a list that cannot be opened is not known, and writes nothing over it", async () => {
    stored(
      world.me,
      10003,
      [],
      sealed(JSON.stringify([["e", POST_A]])),
      NOW - 50,
    );
    world.locked = true;
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.failed).toBe(true));
    // It is not "nothing saved".
    expect(result.current.saved.ready).toBe(false);
    expect(result.current.saved.ids).toEqual([]);
    await expect(act(() => result.current.saved.save(POST_B))).rejects.toThrow(
      SAVED_UNREADABLE,
    );
    expect(world.published).toHaveLength(0);
    // Unlocked, the same list opens again.
    world.locked = false;
    await act(() => result.current.saved.refetch());
    await waitFor(() => expect(result.current.saved.ids).toEqual([POST_A]));
  });

  it("will not save more than the limit, and still lets one go", async () => {
    const many = Array.from({ length: MAX_SAVED }, (_, n) => [
      "e",
      n.toString(16).padStart(64, "0"),
    ]);
    stored(world.me, 10003, [], sealed(JSON.stringify(many)), NOW - 50);
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.ready).toBe(true));
    await expect(act(() => result.current.saved.save(POST_A))).rejects.toThrow(
      SAVED_FULL,
    );
    expect(world.published).toHaveLength(0);
    await act(() => result.current.saved.remove("0".repeat(64)));
    expect(privateIds()).toHaveLength(MAX_SAVED - 1);
  });

  it("says so when the server refuses, and the post is not shown as saved", async () => {
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.ready).toBe(true));
    world.refuse = "restricted: slow down";
    await expect(
      act(() => result.current.saved.save(POST_A)),
    ).rejects.toThrow();
    expect(result.current.saved.isSaved(POST_A)).toBe(false);
  });

  it("keeps both when a post is saved and a project followed at the same time", async () => {
    world.writeDelayMs = 25;
    const { result } = hooks();
    await waitFor(() => expect(result.current.saved.ready).toBe(true));
    await act(async () => {
      await Promise.all([
        result.current.saved.save(POST_A),
        result.current.follow.mutateAsync({ coordinate: COORD, follow: true }),
      ]);
    });
    // Both changes are in the list the server holds now, whichever went first.
    const held = world.events.find((e) => e.kind === 10003);
    expect(held?.tags).toContainEqual(["a", COORD]);
    expect(
      (JSON.parse(unsealed(held?.content ?? "")) as string[][]).map(
        (t) => t[1],
      ),
    ).toEqual([POST_A]);
    // Two writes, one after the other, each from the newest list.
    expect(world.published.filter((e) => e.kind === 10003)).toHaveLength(2);
  });
});
