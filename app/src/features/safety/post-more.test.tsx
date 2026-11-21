// Reporting and hiding from a post anywhere outside a room: a report is sent as the server takes it, the reported post stops
// showing for the reporter once the sheet is closed (and only then), a refused report hides nothing, hiding a person is the reader's
// own and goes to the private list, and a signed-out person is sent to make an account instead.
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANA,
  draw,
  NOW,
  note,
  profile,
  reset,
  unsealed,
  world,
} from "./social-harness";
import { reportedBy } from "./reported";

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

import { TopicPage } from "../tags/TopicPage";

beforeEach(() => {
  reset();
  profile(ANA, "Ana");
});
afterEach(cleanup);

/** The More press once the author's name has been read (it is named with the author). */
const moreOfAna = async () =>
  (
    await screen.findAllByRole("button", {
      name: "More actions for Ana's post",
    })
  )[0];

async function openReport(): Promise<HTMLElement> {
  fireEvent.click(await moreOfAna());
  fireEvent.click(await screen.findByRole("button", { name: "Report" }));
  return screen.findByTestId("report-sheet");
}

describe("reporting a post", () => {
  it("sends the report the server takes, says thanks, and hides the post once the sheet is closed", async () => {
    const post = note(ANA, "Spam spam #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    const sheet = await openReport();
    fireEvent.click(within(sheet).getByLabelText("Spam"));
    fireEvent.click(within(sheet).getByTestId("report-send"));
    expect(await within(sheet).findByTestId("report-done")).toBeTruthy();
    const sent = world.published.at(-1);
    expect(sent?.kind).toBe(1984);
    expect(sent?.tags).toEqual([
      ["e", post.id, "spam"],
      ["p", ANA],
    ]);
    // The post stays while the sheet is open, so the thanks is never pulled away.
    expect(screen.getByTestId("post-card")).toBeTruthy();
    expect(
      within(sheet).getByText(/hidden for you on this phone/),
    ).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("post-card")).toBeNull());
    expect(reportedBy(world.me).has(post.id)).toBe(true);
  });

  it("does not hide the post when the report was refused, and says so", async () => {
    const post = note(ANA, "Spam #lamps", NOW - 10, [["t", "lamps"]]);
    world.refuse = "invalid: report target event not found";
    draw(<TopicPage tag="lamps" />);
    const sheet = await openReport();
    fireEvent.click(within(sheet).getByLabelText("Spam"));
    fireEvent.click(within(sheet).getByTestId("report-send"));
    expect((await within(sheet).findByRole("alert")).textContent).toBe(
      "The report was not sent. Try again.",
    );
    fireEvent.click(within(sheet).getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByTestId("report-sheet")).toBeNull(),
    );
    expect(screen.getByTestId("post-card")).toBeTruthy();
    expect(reportedBy(world.me).has(post.id)).toBe(false);
  });

  it("does not hide the post when the sheet is closed without sending", async () => {
    note(ANA, "Fine #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    const sheet = await openReport();
    fireEvent.click(within(sheet).getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByTestId("report-sheet")).toBeNull(),
    );
    expect(screen.getByTestId("post-card")).toBeTruthy();
    expect(world.published).toHaveLength(0);
  });

  it("offers to hide the person too, and that goes to the private list and takes all their posts away", async () => {
    note(ANA, "One #lamps", NOW - 10, [["t", "lamps"]]);
    note(ANA, "Two #lamps", NOW - 20, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    const sheet = await openReport();
    fireEvent.click(within(sheet).getByLabelText("Spam"));
    fireEvent.click(within(sheet).getByTestId("report-send"));
    fireEvent.click(await within(sheet).findByTestId("report-hide-person"));
    await waitFor(() =>
      expect(screen.queryAllByTestId("post-card")).toHaveLength(0),
    );
    const list = world.published.find((e) => e.kind === 10000);
    expect(
      (JSON.parse(unsealed(list?.content ?? "")) as string[][]).map(
        (t) => t[1],
      ),
    ).toEqual([ANA]);
    // Nothing public says who was hidden.
    expect(list?.tags.some((t) => t[0] === "p")).toBe(false);
  });
});

describe("hiding a person from a post", () => {
  it("hides them for the reader, with the way back said", async () => {
    note(ANA, "One #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOfAna());
    fireEvent.click(
      await screen.findByRole("button", { name: "Hide Ana's posts" }),
    );
    await waitFor(() => expect(screen.queryByTestId("post-card")).toBeNull());
    expect(world.published.at(-1)?.kind).toBe(10000);
    expect(await screen.findByText(/Only you stop seeing them/)).toBeTruthy();
    expect(screen.getByText(/Hidden people/)).toBeTruthy();
  });

  it("offers no Report or Hide on a person's own post, only Save, Edit and Delete", async () => {
    note(world.me, "Mine #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    const card = await screen.findByTestId("post-card");
    fireEvent.click(
      await within(card).findByRole("button", { name: /More actions/ }),
    );
    const menu = await screen.findByTestId("post-menu");
    expect(
      within(menu)
        .getAllByRole("button")
        .map((b) => b.textContent)
        .filter((t) => t && t !== "Close"),
    ).toEqual(["Save this post", "Edit", "Delete"]);
  });

  it("does not offer Edit while the post's comments are unknown, and says why, so comments are never left behind", async () => {
    note(world.me, "Mine #lamps", NOW - 10, [["t", "lamps"]]);
    // The read of reactions, reposts and replies fails: the counts are unknown, which is not "no comments".
    world.failKinds = [7];
    draw(<TopicPage tag="lamps" />);
    const card = await screen.findByTestId("post-card");
    fireEvent.click(
      await within(card).findByRole("button", { name: /More actions/ }),
    );
    const menu = await screen.findByTestId("post-menu");
    const edit = within(menu).getByRole("button", { name: "Edit" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(menu.textContent).toContain("have not been read yet");
  });

  it("sends a signed-out person to make an account instead of opening the report", async () => {
    world.signedIn = false;
    note(ANA, "One #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOfAna());
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    await waitFor(() => expect(world.navigated).toHaveLength(1));
    expect(world.navigated[0]).toMatchObject({ to: "/welcome" });
    expect(screen.queryByTestId("report-sheet")).toBeNull();
  });
});

describe("saving from a post", () => {
  it("saves and unsaves from the More menu, which says what the press does and that only the reader sees the list", async () => {
    note(ANA, "One #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    // There is no Save press on the post itself: it is in More.
    await screen.findByTestId("post-card");
    expect(screen.queryByTestId("post-save")).toBeNull();
    fireEvent.click(await moreOfAna());
    fireEvent.click(
      await screen.findByRole("button", { name: "Save this post" }),
    );
    await waitFor(() => expect(world.published.at(-1)?.kind).toBe(10003));
    expect(
      await screen.findByText(/Only you can see your saved posts/),
    ).toBeTruthy();
    fireEvent.click(await moreOfAna());
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove from saved" }),
    );
    await waitFor(() => expect(world.published.at(-1)?.kind).toBe(10003));
    expect(
      await screen.findByText(/Removed from your saved posts/),
    ).toBeTruthy();
    fireEvent.click(await moreOfAna());
    expect(
      await screen.findByRole("button", { name: "Save this post" }),
    ).toBeTruthy();
  });

  it("says why when a save is refused, and the menu still offers Save", async () => {
    note(ANA, "One #lamps", NOW - 10, [["t", "lamps"]]);
    draw(<TopicPage tag="lamps" />);
    fireEvent.click(await moreOfAna());
    await waitFor(() =>
      expect(world.reads.some((f) => f.kinds?.includes(10003))).toBe(true),
    );
    world.refuse = "restricted: slow down";
    fireEvent.click(
      await screen.findByRole("button", { name: "Save this post" }),
    );
    expect(await screen.findByText(/slow down/)).toBeTruthy();
    fireEvent.click(await moreOfAna());
    expect(
      await screen.findByRole("button", { name: "Save this post" }),
    ).toBeTruthy();
  });
});
