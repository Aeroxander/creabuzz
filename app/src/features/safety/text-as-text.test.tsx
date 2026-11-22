// What a person wrote is drawn as text on every list that shows it: a post, a quoted post, a search result (a person's about line
// and a post), a topic's list and the saved list. Markup in it is shown as the characters written and never becomes an element,
// so a post or a profile cannot run anything on a reader's page. (Biome's no-innerHTML rule holds the same line at the source;
// this holds it at the page.)
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANA,
  BO,
  draw,
  nextId,
  NOW,
  note,
  profile,
  reset,
  sealed,
  stored,
  world,
} from "./social-harness";

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

import { NO_ENGAGEMENT } from "@creaton/core/social/engagement.ts";
import { PostCard } from "../posts/PostCard";
import { QuotedPost } from "../posts/QuotedPost";
import { SavedPage } from "../saved/SavedPage";
import { SearchPage } from "../search/SearchPage";
import { TopicPage } from "../tags/TopicPage";

const MARKUP = '<img src=x onerror="alert(1)"><b>bold</b><script>1</script>';
const POST = `${MARKUP} lamps`;

/** Nothing of the written markup became an element, and its characters are on the page. */
function expectText(container: HTMLElement) {
  expect(container.textContent).toContain(MARKUP);
  expect(container.querySelector("img, b, script, iframe")).toBeNull();
}

beforeEach(() => {
  reset();
  profile(ANA, "Ana", MARKUP);
  profile(BO, "Bo");
});
afterEach(cleanup);

describe("what people wrote is drawn as text", () => {
  it("in a post", async () => {
    const post = note(BO, POST, NOW - 10, [["t", "lamps"]]);
    const { container } = draw(
      <PostCard engagement={NO_ENGAGEMENT} event={post} profiles={undefined} />,
    );
    await waitFor(() => expect(container.textContent).toContain(MARKUP));
    expectText(container);
  });

  it("in a quoted post", async () => {
    const quoted = note(BO, POST, NOW - 10);
    const { container } = draw(<QuotedPost id={quoted.id} />);
    await screen.findByTestId("quoted-post");
    expectText(container);
  });

  it("in a person's about line in search", async () => {
    const { container } = draw(<SearchPage q="ana" />);
    await screen.findByTestId("search-person");
    expectText(container);
  });

  it("in a post found by search", async () => {
    note(BO, POST, NOW - 10);
    const { container } = draw(<SearchPage q="lamps" />);
    await waitFor(() => expect(container.textContent).toContain(MARKUP));
    expectText(container);
  });

  it("in a topic's list", async () => {
    note(BO, POST, NOW - 10, [["t", "lamps"]]);
    const { container } = draw(<TopicPage tag="lamps" />);
    await screen.findByTestId("topic-list");
    expectText(container);
  });

  it("in the saved list", async () => {
    world.me = nextId();
    const post = note(BO, POST, NOW - 10);
    stored(
      world.me,
      10003,
      [],
      sealed(JSON.stringify([["e", post.id]])),
      NOW - 5,
    );
    const { container } = draw(<SavedPage />);
    await waitFor(() => expect(container.textContent).toContain(MARKUP));
    expectText(container);
  });
});
