// A season entry, leave or removal and a room stop are records the team signs about the project; the project's own list of
// updates must not show them as something the team said.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { NOW } from "../../../tests/helpers/money-harness";
import { type Project, parseProject } from "./project-record";
import { projectUpdates, useProjectActivity } from "./use-project";

interface Stored {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** The records the mocked server holds; it answers a read by kind only, which is all this page asks. */
const served: { events: Stored[] } = vi.hoisted(() => ({ events: [] }));

vi.mock("../../lib/relay", () => ({
  readMulti: async (filters: { kinds: number[] }[]) =>
    filters.map((f) => served.events.filter((e) => f.kinds.includes(e.kind))),
}));

const FOUNDER = "a".repeat(64);
const record = {
  id: "1".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  tags: [
    ["d", "moss"],
    ["name", "Moss"],
  ],
  content: "{}",
};
const project = parseProject(record) as Project;

/** A record of kind 47003 about the project, with the tags that say what it is. */
const record47003 = (
  extra: string[][],
  content: string,
  ago: number,
): Stored => ({
  id: `${ago}`.padStart(64, "0"),
  pubkey: FOUNDER,
  kind: 47003,
  created_at: NOW - ago,
  tags: [["a", project.coordinate], ...extra],
  content,
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

describe("a project's updates", () => {
  it("leave out the records that put the project in a season or stop a person writing in its room", async () => {
    served.events = [
      record47003([["season-entry", "1"]], "{}", 500),
      record47003([["season-leave", "1"]], "{}", 400),
      record47003([["season-remove", "1"]], "{}", 300),
      record47003([["room-mute", "c".repeat(64)]], "{}", 200),
      record47003(
        [],
        JSON.stringify({ title: "Real news", body: "We shipped." }),
        100,
      ),
    ];
    const { result } = renderHook(() => useProjectActivity(project), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const shown = projectUpdates(project, result.current.data as never);
    expect(shown.map((u) => u.title)).toEqual(["Real news"]);
  });
});
