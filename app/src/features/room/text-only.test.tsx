// What people write is drawn as text, never as page parts: a post, an answer and a team notice in the room, and an update on the
// project's Updates tab. A script-looking or tag-looking line shows with its characters as written, and the page gets no `img`
// and no `b` element from it. The test posts through the real components (the room, the Updates tab), so a change that sets
// the words as markup fails here.
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, screen, within } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import { parseProject } from "../project/project-record";
import type { ProjectActivity } from "../project/use-project";
import {
  ANA,
  BO,
  COORD,
  draw,
  FOUNDER,
  KEY,
  NOW,
  reset,
  roomPost,
  roomTags,
  stored,
  world,
} from "./room-harness";

vi.mock(
  "../../lib/relay",
  async () => (await import("./room-harness")).relayMock,
);
vi.mock(
  "./use-room-standing",
  async () => (await import("./room-harness")).standingMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("./room-harness")).accountMock,
);
vi.mock("../tasks/use-tasks", () => ({
  useProjectTasks: () => ({ data: { tasks: [] } }),
}));
vi.mock("../../lib/mutes", () => ({
  useMutes: () => ({
    muted: new Set<string>(),
    ready: true,
    readable: true,
    pending: false,
    hide: async () => undefined,
    showAgain: async () => undefined,
  }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/u">{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: () => "/p",
}));

import { DemoCard } from "../season/DemoCard";
import { UpdatesTab } from "../project/UpdatesTab";
import { RoomTab } from "./RoomTab";

const IMG = "<img src=x onerror=alert(1)>";
const BOLD = "<b>bold</b>";

const parsed = parseProject({
  id: "9".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  content: '{"pitch":"Lamps"}',
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
    ["chain-key", KEY],
  ],
});
if (!parsed) throw new Error("no project");
const project = parsed;
const profiles = {
  [ANA]: { name: "Ana", display_name: "Ana" },
  [BO]: { name: "Bo", display_name: "Bo" },
  [FOUNDER]: { name: "Fay", display_name: "Fay" },
};

/** No picture and no bold element anywhere in the document: the words never became page parts. */
function expectNoParts() {
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("b")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
}

beforeEach(() => {
  reset();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("the holder room draws what people write as text", () => {
  it("a post, an answer and the team's pinned notice show their characters as written", async () => {
    const root = roomPost(ANA, `${IMG} first`, NOW - 300);
    stored(
      BO,
      1,
      [["e", root.id, "", "root"], ...roomTags],
      `${BOLD} answer`,
      NOW - 200,
    );
    stored(
      FOUNDER,
      47003,
      [["a", COORD]],
      JSON.stringify({ title: BOLD, body: IMG }),
      NOW - 100,
    );
    world.events.push({
      id: "9".repeat(64),
      pubkey: FOUNDER,
      kind: 37001,
      created_at: NOW - 1000,
      content: '{"pitch":"Lamps"}',
      tags: project.event.tags,
      sig: "",
    } as never);
    draw(
      <RoomTab
        numbers={parsedExample()}
        profiles={profiles}
        project={project}
        team={[FOUNDER]}
      />,
    );
    const post = await screen.findByText(`${IMG} first`);
    expect(post.tagName).toBe("P");
    expect(screen.getByText(`${BOLD} answer`)).toBeTruthy();
    const pinned = await screen.findByTestId("room-notice-pinned");
    expect(within(pinned).getByText(BOLD).textContent).toBe(BOLD);
    expect(within(pinned).getByText(IMG).textContent).toBe(IMG);
    expectNoParts();
  });
});

describe("the project's Updates tab draws an update's words as text", () => {
  it("an update and a post about the project show as written", () => {
    const activity = {
      isPending: false,
      isError: false,
      data: {
        updates: [
          {
            id: "a".repeat(64),
            author: FOUNDER,
            at: NOW - 100,
            title: BOLD,
            body: IMG,
            kind: "update",
          },
          {
            id: "b".repeat(64),
            author: ANA,
            at: NOW - 200,
            title: "",
            body: `${BOLD} ${IMG}`,
            kind: "post",
          },
        ],
        answers: [],
        asks: [],
        declines: [],
      } satisfies ProjectActivity,
    } as unknown as UseQueryResult<ProjectActivity>;
    draw(
      <UpdatesTab
        activity={activity}
        canPost={false}
        profiles={profiles}
        project={project}
      />,
    );
    const cards = screen.getAllByTestId("project-update");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("heading").textContent).toBe(BOLD);
    expect(cards[0].textContent).toContain(IMG);
    expect(cards[1].textContent).toContain(`${BOLD} ${IMG}`);
    expectNoParts();
  });
});

describe("the demo-day card draws the team's last update as text", () => {
  it("a title and a body that look like tags show as written", async () => {
    const root = createRootRoute({
      component: () => (
        <DemoCard
          batch={0}
          card={{
            project,
            numbers: null,
            freshness: null,
            update: { at: NOW - 60, title: BOLD, body: IMG },
          }}
        />
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: "/p/$ref",
          component: () => null,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    draw(<RouterProvider router={router} />);
    const update = await screen.findByTestId("demo-update");
    expect(update.textContent).toContain(BOLD);
    expect(update.textContent).toContain(IMG);
    expectNoParts();
  });
});
