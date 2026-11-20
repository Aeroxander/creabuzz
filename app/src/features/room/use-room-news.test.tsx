// The "New" dot on the Room tab: something in the room (a post, or a notice from the team) newer than the person last looked.
// Looking clears it, and a device that cannot remember never hides news.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProject } from "../project/project-record";
import type { ProjectActivity } from "../project/use-project";
import {
  COORD,
  FOUNDER,
  KEY,
  NOW,
  reset,
  roomPost,
  world,
} from "./room-harness";
import { markRoomSeen, seenKey } from "./room-seen";

vi.mock(
  "../../lib/relay",
  async () => (await import("./room-harness")).relayMock,
);

vi.mock(
  "../../lib/account",
  async () => (await import("./room-harness")).accountMock,
);

import { useRoomNews } from "./use-room-news";

const parsed = parseProject({
  id: "9".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  content: "{}",
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
    ["chain-key", KEY],
  ],
});
if (!parsed) throw new Error("no project");
const project = parsed;
const noActivity: ProjectActivity = {
  updates: [],
  answers: [],
  asks: [],
  declines: [],
};
const update = (at: number): ProjectActivity => ({
  ...noActivity,
  updates: [
    {
      id: "u1",
      author: FOUNDER,
      at,
      title: "Week 3",
      body: "",
      kind: "update",
    },
  ],
});

function news(activity: ProjectActivity | undefined, enabled = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useRoomNews(project, enabled, activity), { wrapper });
}

beforeEach(() => {
  reset();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("the New dot", () => {
  it("shows for a post newer than the last look and goes once the room was seen", async () => {
    roomPost("2".repeat(64), "Hello", NOW - 100);
    const first = news(undefined);
    await waitFor(() => expect(first.result.current).toBe(true));
    markRoomSeen(seenKey(world.me, COORD), NOW - 100);
    const second = news(undefined);
    await waitFor(() => expect(world.events).toHaveLength(1));
    // Let the read finish: still nothing new.
    await new Promise((r) => setTimeout(r, 30));
    expect(second.result.current).toBe(false);
  });

  it("is the account's own: another account looking at the room on the same device does not clear it", async () => {
    roomPost("2".repeat(64), "Hello", NOW - 100);
    markRoomSeen(seenKey("a".repeat(64), COORD), NOW - 100);
    const mine = news(undefined);
    await waitFor(() => expect(mine.result.current).toBe(true));
  });

  it("shows for a notice from the team too, and for nothing in an empty room", async () => {
    const quiet = news(undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(quiet.result.current).toBe(false);
    const told = news(update(NOW - 50));
    await waitFor(() => expect(told.result.current).toBe(true));
    markRoomSeen(seenKey(world.me, COORD), NOW - 50);
    const seen = news(update(NOW - 50));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.result.current).toBe(false);
  });

  it("is off where investing is off, and never hides news on a device that cannot remember", async () => {
    roomPost("2".repeat(64), "Hello", NOW - 100);
    const off = news(undefined, false);
    await new Promise((r) => setTimeout(r, 30));
    expect(off.result.current).toBe(false);
    markRoomSeen(seenKey(world.me, COORD), NOW);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const forgetful = news(undefined);
    await waitFor(() => expect(forgetful.result.current).toBe(true));
  });
});
