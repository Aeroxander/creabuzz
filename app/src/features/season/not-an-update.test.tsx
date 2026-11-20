// A season entry, leave or removal and a room stop are records the team signs about the project; the project's own list of
// updates must not show them as something the team said.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { NOW } from "../../../tests/helpers/money-harness";
import { serve, step, update } from "../../../tests/helpers/season-relay";
import { type Project, parseProject } from "../project/project-record";
import { projectUpdates, useProjectActivity } from "../project/use-project";

vi.mock(
  "../../lib/relay",
  async () =>
    (await import("../../../tests/helpers/season-relay")).seasonRelayMock,
);

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

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

describe("a project's updates", () => {
  it("leave out the records that put the project in a season or stop a person writing in its room", async () => {
    serve([
      step(1, project.coordinate, "entry", FOUNDER, 500),
      step(1, project.coordinate, "leave", FOUNDER, 400),
      step(1, project.coordinate, "remove", FOUNDER, 300),
      {
        ...update(project.coordinate, FOUNDER, { title: "", body: "" }, 200),
        tags: [
          ["a", project.coordinate],
          ["room-mute", "c".repeat(64)],
        ],
        content: "{}",
      },
      update(
        project.coordinate,
        FOUNDER,
        { title: "Real news", body: "We shipped." },
        100,
      ),
    ]);
    const { result } = renderHook(() => useProjectActivity(project), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const shown = projectUpdates(project, result.current.data as never);
    expect(shown.map((u) => u.title)).toEqual(["Real news"]);
  });
});
