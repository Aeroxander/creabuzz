// The season band on Home, end to end against a mocked server: the newest season record and the clock, the count of projects on
// demo day, and a founder entering a project or taking it out. A refusal is said in plain words and the press stays.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "../../../tests/helpers/money-harness";
import {
  DAY,
  published,
  refuse,
  reads,
  type Stored,
  season,
  serve,
  step,
} from "../../../tests/helpers/season-relay";
import { ToastProvider } from "../../ui/toast";
import { SeasonBand } from "./SeasonBand";
import { bandWords } from "./season-words";

const who = vi.hoisted(() => ({ me: null as string | null }));
vi.mock(
  "../../lib/relay",
  async () =>
    (await import("../../../tests/helpers/season-relay")).seasonRelayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: who.me, locked: false }),
}));

const ME = "b".repeat(64);
const OTHER = "c".repeat(64);
const coordinate = (author: string, id: string) => `37001:${author}:${id}`;
/** A chain key is 32 bytes of hex: made from the project's id. */
const KEY = (id: string) =>
  `0x${Buffer.from(id).toString("hex").padEnd(64, "0")}`;

function project(
  author: string,
  id: string,
  name: string,
  over: { chainKey?: string | null; team?: string[]; unlisted?: boolean } = {},
): Stored {
  const key = over.chainKey === undefined ? KEY(id) : over.chainKey;
  return {
    id: `${id}${author.slice(0, 4)}`.padEnd(64, "0"),
    pubkey: author,
    kind: 37001,
    created_at: NOW - DAY,
    tags: [
      ["d", id],
      ["name", name],
      ...(key ? [["chain-key", key]] : []),
      ...(over.team ?? []).flatMap((p) => [
        ["team", p, "helper"],
        ["p", p],
      ]),
    ],
    content: over.unlisted ? JSON.stringify({ listing: "unlisted" }) : "{}",
  };
}

function band() {
  const root = createRootRoute({ component: SeasonBand });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([stub("/season/$n"), stub("/p/$ref")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const open = season(2, { start: -3, demo: 39, end: 46 });
const demo = season(3, { start: -43, demo: -1, end: 6 });
const upcoming = season(4, { start: 5, demo: 47, end: 54 });
const ended = season(1, { start: -90, demo: -48, end: -41 });

beforeEach(() => {
  who.me = null;
  applyServerSettings({ investing: true });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("the band's states", () => {
  it("says nothing without a season record, and nothing where the server does not offer investing", async () => {
    serve([]);
    band();
    await waitFor(() => expect(reads.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("season-band")).toBeNull();
    cleanup();
    applyServerSettings(null);
    serve([open]);
    band();
    expect(screen.queryByTestId("season-band")).toBeNull();
    expect(reads).toHaveLength(0);
  });

  it("before the start: the date, and no entry", async () => {
    serve([upcoming]);
    band();
    const words = await screen.findByTestId("season-band-words");
    expect(words.textContent).toMatch(/^Season 4 starts \d+ \w+ \d{4}\.$/);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("season-demo-link")).toBeNull();
  });

  it("open: says until when, and a visitor with no account is offered nothing and costs no read of the entries", async () => {
    serve([open]);
    band();
    const words = await screen.findByTestId("season-band-words");
    expect(words.textContent).toMatch(
      /^Season 2 is open\. Projects can enter until demo day on /,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(reads.some((f) => f.kinds?.includes(47003))).toBe(false);
  });

  it("demo day: the number of projects that are in (a left or removed one is not), and a link to the page", async () => {
    const t = (id: string) => coordinate(OTHER, id);
    serve([
      demo,
      step(3, t("a"), "entry", OTHER, 500),
      step(3, t("b"), "entry", OTHER, 500),
      step(3, t("b"), "leave", OTHER, 400),
      step(3, t("c"), "entry", OTHER, 500),
      step(3, t("c"), "remove", `${"0".repeat(63)}1`, 300),
      step(3, t("d"), "entry", OTHER, 500),
    ]);
    band();
    await waitFor(() =>
      expect(screen.getByTestId("season-band-words").textContent).toBe(
        bandWords(
          {
            number: 3,
            startsAt: 0,
            demoDayAt: 0,
            endsAt: 0,
            signedAt: 0,
            id: "",
          },
          "demo",
          2,
        ),
      ),
    );
    const link = screen.getByRole("link", { name: "See demo day" });
    expect(link.getAttribute("href")).toBe("/season/3");
  });

  it("after the season: the last one's end, and a way to its demo day", async () => {
    serve([ended]);
    band();
    await screen.findByText(/^No season is open\. The last one ended /);
    expect(
      screen
        .getByRole("link", { name: "See that demo day" })
        .getAttribute("href"),
    ).toBe("/season/1");
  });

  it("two seasons: demo day before entry, entry before the next start", async () => {
    serve([open, demo, upcoming, ended]);
    band();
    await screen.findByRole("link", { name: "See demo day" });
    expect(screen.getByTestId("season-band-words").textContent).toMatch(
      /^Demo day/,
    );
  });
});

describe("entering a project", () => {
  const mine = project(ME, "moss", "Moss");

  it("offers each of the founder's launched projects by name and sends one record that names the project, the season and the entry", async () => {
    who.me = ME;
    serve([
      open,
      mine,
      project(ME, "fern", "Fern"),
      project(OTHER, "oak", "Oak"),
    ]);
    band();
    const enter = await screen.findByRole("button", { name: "Enter Moss" });
    expect(screen.getByRole("button", { name: "Enter Fern" })).not.toBeNull();
    // Nobody else's project is offered.
    expect(screen.queryByRole("button", { name: "Enter Oak" })).toBeNull();
    fireEvent.click(enter);
    await waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toEqual({
      kind: 47003,
      tags: [
        ["a", coordinate(ME, "moss")],
        ["t", "season-2"],
        ["season-entry", "2"],
      ],
      content: "{}",
    });
  });

  it("a project is offered when the founder lists the person on the team", async () => {
    who.me = ME;
    serve([open, project(OTHER, "oak", "Oak", { team: [ME] })]);
    band();
    await screen.findByRole("button", { name: "Enter Oak" });
  });

  it("a project that is not launched on the network, or is unlisted, is not offered", async () => {
    who.me = ME;
    serve([
      open,
      project(ME, "young", "Young", { chainKey: null }),
      project(ME, "quiet", "Quiet", { unlisted: true }),
      mine,
    ]);
    band();
    await screen.findByRole("button", { name: "Enter Moss" });
    expect(screen.queryByRole("button", { name: "Enter Young" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter Quiet" })).toBeNull();
  });

  it("a project that is in says so and offers Leave, named for a screen reader; Leave sends the leave record", async () => {
    who.me = ME;
    serve([open, mine, step(2, coordinate(ME, "moss"), "entry", ME)]);
    band();
    await screen.findByText("Moss is in.");
    expect(screen.queryByRole("button", { name: "Enter Moss" })).toBeNull();
    const leave = screen.getByRole("button", { name: "Leave Moss" });
    // The visible label is "Leave" and the accessible name holds it.
    expect(leave.textContent).toContain("Leave");
    fireEvent.click(leave);
    await waitFor(() => expect(published).toHaveLength(1));
    expect(published[0].tags).toEqual([
      ["a", coordinate(ME, "moss")],
      ["t", "season-2"],
      ["season-leave", "2"],
    ]);
  });

  it("a refusal is said in plain words, the press stays, and nothing of the server's own text shows", async () => {
    who.me = ME;
    serve([open, mine]);
    band();
    const enter = await screen.findByRole("button", { name: "Enter Moss" });
    refuse.message =
      "restricted: at least 3 people have to back this project first";
    fireEvent.click(enter);
    const alert = await screen.findByTestId("season-problem");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(
      "At least 3 people have to back this project first.",
    );
    expect(screen.getByRole("button", { name: "Enter Moss" })).not.toBeNull();
    // Another refusal replaces it, and a try that works clears it.
    refuse.message = "restricted: this season is full";
    fireEvent.click(screen.getByRole("button", { name: "Enter Moss" }));
    await waitFor(() =>
      expect(screen.getByTestId("season-problem").textContent).toBe(
        "This season is full.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enter Moss" }));
    await waitFor(() =>
      expect(screen.queryByTestId("season-problem")).toBeNull(),
    );
  });

  it("there is one region with a heading, and each press has one name", async () => {
    who.me = ME;
    serve([open, mine, project(ME, "fern", "Fern")]);
    band();
    await screen.findByRole("button", { name: "Enter Moss" });
    const region = screen.getByRole("region", { name: "Seasons" });
    const names = within(region)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(new Set(names).size).toBe(names.length);
  });
});
