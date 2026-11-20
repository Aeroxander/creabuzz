// biome-ignore-all lint/suspicious/noExplicitAny: a record is changed as loose JSON, the way a hostile one arrives
// The live feed on the page (plan section 7.5): the items and their words, "Last 2 days" with joins and take-outs at equal
// weight, the hours behind a press, the rounding note, and nothing at all for a record with no feed, a feed that could not be
// worked out, or a record past a day.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chainIdentityV2,
  numbersV2Content,
  withSocial,
} from "../../../tests/helpers/numbers-v2-fixture";
import {
  COORDINATE,
  event,
  NOW,
  SERVER,
} from "../../../tests/helpers/numbers-v2-parse";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { parseNumbers, type ProjectNumbers } from "../money/numbers";
import { NOT_A_RETURN_LITERAL } from "../../../tests/helpers/legal-words";
import type { Project } from "../project/project-record";
import { ProjectFeed } from "./ProjectFeed";
import { FIRST_ITEMS, MORE_ITEMS } from "./feed-rows";
import { itemWords } from "./feed-words";

type Json = Record<string, any>;
const project = { name: "Lantern" } as unknown as Project;

/** The record the server would sign at `NOW`, with the feed changed by `patch`. */
function numbersWith(
  patch?: (feed: Json) => void,
  parts?: Parameters<typeof withSocial>[0],
  builtAgo = 0,
): ProjectNumbers {
  const content = numbersV2Content({
    coordinate: COORDINATE,
    now: NOW - builtAgo,
    patch: (c) => {
      if (parts) withSocial(parts)(c);
      if (patch && c.feed) patch(c.feed as Json);
    },
  });
  const parsed = parseNumbers(
    event(content, {
      tags: [["d", chainIdentityV2(COORDINATE).key]],
      created_at: NOW - builtAgo,
    }),
    SERVER,
  );
  if (!parsed || parsed.removed) throw new Error("the record did not parse");
  return parsed;
}

const draw = (numbers: ProjectNumbers | null) =>
  render(<ProjectFeed numbers={numbers} project={project} />);

/** Puts joins and a take-out in the last hours of a feed, so that both counts and a net are there. */
const busy = (f: Json) => {
  f.hours[44] = {
    ...f.hours[44],
    joins: 3,
    tookOut: 0,
    net: { dir: "in", amount: "500000000" },
  };
  f.hours[46] = {
    ...f.hours[46],
    joins: 2,
    tookOut: 1,
    net: { dir: "in", amount: "300000000" },
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW * 1000));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("what happened", () => {
  it("shows the newest items first, a few at a time, and ten more with each press of Show earlier", () => {
    const n = numbersWith();
    const items = n.feed?.items ?? [];
    expect(items.length).toBeGreaterThan(FIRST_ITEMS + MORE_ITEMS - 1);
    draw(n);
    const rows = () => screen.getAllByTestId("feed-item");
    expect(rows()).toHaveLength(FIRST_ITEMS);
    // Newest first, in the words of the plan, from the record's own rows.
    rows().forEach((row, i) => {
      expect(row.textContent).toContain(
        itemWords(items[i], Math.floor(Date.now() / 1000)),
      );
    });
    fireEvent.click(screen.getByTestId("feed-show-earlier"));
    expect(rows()).toHaveLength(FIRST_ITEMS + MORE_ITEMS);
    // The press does not lose the reader's place: focus lands on the first row it revealed.
    expect(document.activeElement).toBe(rows()[FIRST_ITEMS]);
    fireEvent.click(screen.getByTestId("feed-show-earlier"));
    expect(rows()).toHaveLength(items.length);
    // Nothing left to show: the press is gone.
    expect(screen.queryByTestId("feed-show-earlier")).toBeNull();
  });

  it("does not repeat the line about not being a return (the money card above it has the one), and says the rounding and no-names note", () => {
    draw(numbersWith());
    const feed = screen.getByTestId("project-feed");
    expect(feed.textContent?.split(NOT_A_RETURN_LITERAL)).toHaveLength(1);
    expect(screen.getByTestId("feed-rounding").textContent).toBe(
      "Amounts are rounded to the nearest 100 dollars. No names are shown.",
    );
  });

  it("is a labelled region with the title Lately", () => {
    draw(numbersWith());
    expect(screen.getByRole("region", { name: "Lately" })).toBeTruthy();
  });
});

describe("the last two days", () => {
  it("draws joins and take-outs at the same size and weight, in one line, from the record's own hours", () => {
    const n = numbersWith(busy);
    draw(n);
    const joins = screen.getByTestId("feed-joins");
    const out = screen.getByTestId("feed-took-out");
    const sumJoins = (n.feed?.hours ?? []).reduce((s, h) => s + h.joins, 0);
    const sumOut = (n.feed?.hours ?? []).reduce((s, h) => s + h.tookOut, 0);
    expect(joins.textContent).toBe(`${sumJoins} backed`);
    expect(out.textContent).toBe(`${sumOut} took out`);
    // Equal weight: the same element and the same classes; neither is green or red.
    expect(joins.tagName).toBe(out.tagName);
    expect(joins.className).toBe(out.className);
    expect(joins.className).not.toMatch(
      /green|red|emerald|rose|danger|success/,
    );
    expect(screen.getByTestId("feed-lately").textContent).toMatch(
      /^Last 2 days: \d+ backed, \d+ took out\./,
    );
  });

  it("says which way the money went, rounded", () => {
    draw(numbersWith(busy));
    // 500 and 300 in, and the example's 400 out: 400 more came in than went out.
    expect(screen.getByTestId("feed-net").textContent).toBe(
      "About 400 dollars more came in than went out.",
    );
    cleanup();
    draw(numbersWith());
    expect(screen.getByTestId("feed-net").textContent).toBe(
      "About 400 dollars more went out than came in.",
    );
  });

  it("is not drawn when nothing moved, and the empty words come only with no items either", () => {
    const quiet = (f: Json) => {
      for (const h of f.hours) {
        h.joins = 0;
        h.tookOut = 0;
        h.net = { dir: "even", amount: "0" };
      }
    };
    draw(numbersWith(quiet));
    expect(screen.queryByTestId("feed-lately")).toBeNull();
    expect(screen.queryByTestId("feed-empty")).toBeNull();
    cleanup();
    draw(
      numbersWith((f) => {
        quiet(f);
        f.items = [];
      }),
    );
    expect(screen.getByTestId("feed-empty").textContent).toBe(
      "Nothing has happened here lately.",
    );
    expect(screen.queryByTestId("feed-items")).toBeNull();
  });

  it("keeps the hours behind one press, and draws only the hours in which something moved", () => {
    const n = numbersWith(busy);
    draw(n);
    expect(screen.queryByTestId("feed-hours")).toBeNull();
    const press = screen.getByTestId("feed-by-hour");
    expect(press.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(press);
    expect(press.getAttribute("aria-expanded")).toBe("true");
    const moved = (n.feed?.hours ?? []).filter((h) => h.joins + h.tookOut > 0);
    const rows = screen.getAllByTestId("feed-hour");
    expect(rows).toHaveLength(moved.length);
    // Newest first, each with both counts in the same form.
    expect(rows[0].textContent).toMatch(/\d+ backed, \d+ took out\./);
    // The two counts of a row carry the same classes too.
    const spans = rows[0].querySelectorAll("span.num");
    expect(spans[0].className).toBe(spans[1].className);
  });
});

describe("what is never drawn", () => {
  it("shows no name, no address, no volume and no price anywhere", () => {
    draw(numbersWith(busy));
    fireEvent.click(screen.getByTestId("feed-by-hour"));
    fireEvent.click(screen.getByTestId("feed-show-earlier"));
    const text = screen.getByTestId("project-feed").textContent ?? "";
    expect(text).not.toMatch(/0x[0-9a-f]{4}|npub|volume|price|profit|gain|\$/i);
  });

  it("draws nothing for a record from an older server, or one whose feed could not be worked out", () => {
    const old = draw(numbersWith(undefined, { feed: "absent" }));
    expect(old.container.firstChild).toBeNull();
    cleanup();
    const unknown = draw(numbersWith(undefined, { feed: null }));
    expect(unknown.container.firstChild).toBeNull();
    cleanup();
    expect(draw(null).container.firstChild).toBeNull();
  });

  it("draws nothing for a record past a day, since its amounts are money, and says 'as of' for one past three refreshes", () => {
    const stale = draw(numbersWith(undefined, undefined, 25 * 60 * 60));
    expect(stale.container.firstChild).toBeNull();
    cleanup();
    draw(numbersWith(undefined, undefined, 2 * 60 * 60));
    expect(screen.getByTestId("feed-as-of").textContent).toMatch(
      /^Numbers as of /,
    );
    cleanup();
    draw(numbersWith());
    expect(screen.queryByTestId("feed-as-of")).toBeNull();
  });
});

describe("hours that rounded to nothing", () => {
  it("five small backs in one hour each and a small take-out do not read 'about as much came in as went out'", () => {
    draw(
      numbersWith((f) => {
        for (const h of f.hours) {
          h.joins = 0;
          h.tookOut = 0;
          h.net = { dir: "even", amount: "0" };
        }
        for (const i of [39, 40, 41, 42, 43]) f.hours[i].joins = 1;
        f.hours[45].tookOut = 1;
      }),
    );
    const text = screen.getByTestId("feed-lately").textContent ?? "";
    expect(text).toMatch(/5 backed, 1 took out/);
    expect(text).not.toMatch(/About as much came in as went out/);
    expect(screen.getByTestId("feed-net").textContent).toBe(
      "Some amounts were too small to show, so there is no total.",
    );
  });

  it("an hour with both a back and a take-out that rounded to nothing says there is no total for that hour too", () => {
    draw(
      numbersWith((f) => {
        f.hours[46] = {
          ...f.hours[46],
          joins: 1,
          tookOut: 1,
          net: { dir: "even", amount: "0" },
        };
      }),
    );
    fireEvent.click(screen.getByTestId("feed-by-hour"));
    expect(screen.getByTestId("feed-hours").textContent).not.toMatch(
      /About as much came in/,
    );
  });
});

describe("assistive reading", () => {
  it("has no serious accessibility problem, with the hours open", async () => {
    const view = draw(numbersWith(busy));
    fireEvent.click(screen.getByTestId("feed-by-hour"));
    expect(await seriousViolations(view.container)).toEqual([]);
  });
});
