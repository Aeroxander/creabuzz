// What the room does when something goes wrong or two people share a device: a balance that could not be read is not "you do not
// back this" (and has a retry), a refused like says so and a second press waits, an Undo that is not saved says so, an unsent
// post of one account is never in the next account's box, and the removal sheet says only what is true about the reason.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import { parseProject } from "../project/project-record";
import {
  ANA,
  BO,
  draw,
  FOUNDER,
  KEY,
  MATE,
  NOW,
  reset,
  roomPost,
  world,
} from "./room-harness";
import { forgetRoomDrafts } from "./use-draft";

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
const hideListFailed = vi.hoisted(() => ({ value: false }));
vi.mock("../../lib/mutes", async () => {
  const { useState } = await import("react");
  return {
    useMutes: () => {
      const [muted, setMuted] = useState<Set<string>>(new Set());
      return {
        muted,
        ready: true,
        readable: true,
        pending: false,
        failed: hideListFailed.value,
        hide: async (pk: string) => setMuted(new Set([...muted, pk])),
        showAgain: async () => {
          throw new Error("offline");
        },
      };
    },
  };
});
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/u">{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: () => "/p",
}));

import { RoomTab } from "./RoomTab";

const DEE = "d".repeat(64);
const record = {
  id: "9".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  content: '{"pitch":"Lamps","started":1}',
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
    ["t", "dao-launchpad"],
    ["chain-key", KEY],
    ["team", MATE, "designer", "inv-1"],
    ["admission", "curated"],
  ],
  sig: "",
};
const parsed = parseProject(record);
if (!parsed) throw new Error("no project");
const project = parsed;
const profiles = {
  [ANA]: { name: "Ana", display_name: "Ana" },
  [BO]: { name: "Bo", display_name: "Bo" },
  [DEE]: { name: "Dee", display_name: "Dee" },
  [MATE]: { name: "Max", display_name: "Max" },
  [FOUNDER]: { name: "Fay", display_name: "Fay" },
};

function room(me: string, team = [FOUNDER]) {
  world.me = me;
  world.events.push(record as never);
  return draw(
    <RoomTab
      numbers={parsedExample()}
      profiles={profiles}
      project={project}
      team={team}
    />,
  );
}
const more = (name: string) =>
  screen.findByRole("button", { name: `More actions for ${name}'s post` });
const menu = () => screen.getByTestId("post-menu");

beforeEach(() => {
  reset();
  sessionStorage.clear();
  hideListFailed.value = false;
});
afterEach(cleanup);

describe("a balance that could not be read", () => {
  it("is said so, with a Try again press, and never sends a holder back to Back", async () => {
    world.standing = { kind: "could-not-check" };
    room(DEE);
    const box = await screen.findByTestId("room-could-not-check");
    expect(box.textContent).toMatch(/could not check/);
    expect(screen.queryByTestId("room-back")).toBeNull();
    expect(screen.queryByTestId("room-composer")).toBeNull();
    fireEvent.click(within(box).getByRole("button", { name: "Try again" }));
    expect(world.retried).toBe(1);
  });
});

describe("a list of hidden people that could not be opened", () => {
  it("is said, since someone hidden may show, and is not said when it was read", async () => {
    roomPost(ANA, "Words", NOW - 50);
    hideListFailed.value = true;
    room(DEE);
    expect(
      (await screen.findByTestId("room-hides-unknown")).textContent,
    ).toMatch(/could not be opened/);
    cleanup();
    reset();
    hideListFailed.value = false;
    roomPost(ANA, "Words", NOW - 50);
    room(DEE);
    await screen.findByText("Words");
    expect(screen.queryByTestId("room-hides-unknown")).toBeNull();
  });
});

describe("a like", () => {
  it("says so when the server refuses it", async () => {
    roomPost(ANA, "Nice words", NOW - 50);
    room(DEE);
    world.refuse =
      "restricted: you are writing too fast; try again in a few minutes";
    fireEvent.click(await screen.findByTestId("room-like"));
    expect(
      await screen.findByText(
        "You are writing too fast. Try again in a few minutes.",
      ),
    ).toBeTruthy();
  });

  it("is sent once when the press is repeated before the first one is answered", async () => {
    roomPost(ANA, "Nice words", NOW - 50);
    room(DEE);
    const like = await screen.findByTestId("room-like");
    fireEvent.click(like);
    fireEvent.click(like);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(world.published.filter((e) => e.kind === 7)).toHaveLength(1);
  });
});

describe("hiding a person", () => {
  it("says when Undo was not saved", async () => {
    roomPost(ANA, "Noisy words", NOW - 50);
    room(DEE);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Hide Ana's posts" }),
    );
    await screen.findByText(
      "You will not see posts by Ana any more. Only you stop seeing them.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText("That was not saved. Try again."),
    ).toBeTruthy();
  });

  it("says when Show again in the list was not saved", async () => {
    roomPost(ANA, "Noisy words", NOW - 50);
    room(DEE);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Hide Ana's posts" }),
    );
    await screen.findByTestId("room-hidden-note");
    fireEvent.click(screen.getByTestId("room-hidden-open"));
    fireEvent.click(await screen.findByRole("button", { name: /Show/ }));
    expect(
      await screen.findAllByText("That was not saved. Try again."),
    ).not.toHaveLength(0);
  });
});

describe("an unsent post on a shared device", () => {
  it("is not in the box of the next account to sign in on the same tab", async () => {
    room(DEE);
    const first = (await screen.findByTestId(
      "room-composer-text",
    )) as HTMLTextAreaElement;
    fireEvent.change(first, { target: { value: "private unsent words" } });
    cleanup();
    reset();
    room(BO);
    const next = (await screen.findByTestId(
      "room-composer-text",
    )) as HTMLTextAreaElement;
    expect(next.value).toBe("");
    // The same account finds its own words again.
    cleanup();
    reset();
    room(DEE);
    expect(
      ((await screen.findByTestId("room-composer-text")) as HTMLTextAreaElement)
        .value,
    ).toBe("private unsent words");
  });

  it("is dropped by signing out", () => {
    sessionStorage.setItem("creaton.room.draft.x:y", "words");
    sessionStorage.setItem("something.else", "kept");
    forgetRoomDrafts();
    expect(sessionStorage.getItem("creaton.room.draft.x:y")).toBeNull();
    expect(sessionStorage.getItem("something.else")).toBe("kept");
  });
});

describe("removing a post", () => {
  it("says only what is true about the reason: it is kept in a public log", async () => {
    roomPost(ANA, "Rude words", NOW - 50);
    room(FOUNDER);
    fireEvent.click(await more("Ana"));
    fireEvent.click(
      within(menu()).getByRole("button", { name: "Remove this post" }),
    );
    const sheet = await screen.findByTestId("remove-sheet");
    await waitFor(() =>
      expect(sheet.textContent).toMatch(/kept in a public log/),
    );
    expect(sheet.textContent).not.toMatch(/Everyone can see/);
  });
});
