import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  firstError,
  firstPageError,
  listView,
  moreState,
  olderPageError,
  partialError,
  readUnknown,
} from "./read-view.ts";

const FAILED = new Error("socket closed");

test("a failed read with nothing to show is an error, never an empty list", () => {
  assert.equal(listView({ count: 0, error: FAILED, loading: false }), "error");
  // Still an error while another read is pending: what is shown is not known to be empty.
  assert.equal(listView({ count: 0, error: FAILED, loading: true }), "error");
});

test("what loaded stays on screen when a later read fails", () => {
  assert.equal(listView({ count: 3, error: FAILED, loading: false }), "list");
});

test("an answered read with nothing is empty; an unanswered one is loading", () => {
  assert.equal(listView({ count: 0, error: null, loading: false }), "empty");
  assert.equal(listView({ count: 0, error: null, loading: true }), "loading");
});

test("firstError picks the first failure among several reads", () => {
  assert.equal(firstError(null, undefined, FAILED), FAILED);
  assert.equal(firstError(null, undefined), null);
});

test("a failed older page waits for Try again instead of asking again on every render", () => {
  assert.equal(
    moreState({ hasMore: true, loadingMore: false, failed: true }),
    "failed",
  );
  assert.equal(
    moreState({ hasMore: true, loadingMore: true, failed: true }),
    "loading",
  );
  assert.equal(
    moreState({ hasMore: true, loadingMore: false, failed: false }),
    "idle",
  );
  assert.equal(
    moreState({ hasMore: false, loadingMore: false, failed: false }),
    "end",
  );
});

test("an older page's failure is told apart from a failed first read", () => {
  const older = { error: FAILED, isFetchNextPageError: true };
  const first = { error: FAILED, isFetchNextPageError: false };
  assert.equal(olderPageError(older), FAILED);
  assert.equal(firstPageError(older), null);
  assert.equal(olderPageError(first), null);
  assert.equal(firstPageError(first), FAILED);
  assert.equal(firstPageError({ error: null }), null);
});

test("a list with one failed read says so above what loaded; a whole list says nothing", () => {
  // Saved short posts failed, saved board posts loaded: the list shows, and so does the failure.
  const view = listView({ count: 1, error: FAILED, loading: false });
  assert.equal(view, "list");
  assert.equal(partialError(view, FAILED), FAILED);
  assert.equal(partialError("list", null), null);
  // The full error view already says it; no second message.
  assert.equal(partialError("error", FAILED), null);
  assert.equal(partialError("empty", null), null);
});

/** Production pages read these helpers (the `editSurfaceContract.test.mjs` pattern). */
const ROOT = new URL("../../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");

test("every social list page shows a failed read as an error with a retry", () => {
  const pages = {
    "src/features/social/ui/ExplorePage.tsx": [
      "social-trending-error",
      "social-people-error",
      "social-hashtags-error",
    ],
    "src/features/social/ui/BookmarksPage.tsx": ["social-bookmarks-error"],
    "src/features/social/ui/SearchPage.tsx": [
      "social-search-posts-error",
      "social-search-people-error",
    ],
    "src/features/feed/ui/ProfilePage.tsx": [
      "profile-posts-error",
      "profile-likes-error",
    ],
  };
  assert.match(
    read("src/features/social/ui/SocialHomePage.tsx"),
    /tab === "following" && following\.error && !following\.data/,
  );
  for (const [path, ids] of Object.entries(pages)) {
    const source = read(path);
    assert.match(source, /listView\(\{/, path);
    for (const id of ids) assert.match(source, new RegExp(`"${id}"`), path);
  }
});

test("pages whose lists mix reads say when one of them failed", () => {
  const pages = {
    "src/features/social/ui/BookmarksPage.tsx": [
      "social-bookmarks-partial-error",
    ],
    "src/features/feed/ui/ProfilePage.tsx": [
      "profile-posts-partial-error",
      "profile-likes-partial-error",
    ],
  };
  for (const [path, ids] of Object.entries(pages)) {
    const source = read(path);
    assert.match(source, /partialError\(view, error\)/, path);
    for (const id of ids) assert.match(source, new RegExp(`"${id}"`), path);
  }
  const search = read("src/features/social/ui/SearchPage.tsx");
  // A failed board search can be retried from both the error view and its banner.
  assert.match(search, /if \(board\.error\) board\.refetch\(\)/);
  assert.match(search, /onRetry=\{board\.refetch\}/);
  // The retry is board search's own: it asks that query again.
  assert.match(
    read("src/features/board/use-board-search.ts"),
    /refetch: \(\) => void found\.refetch\(\)/,
  );
});

test("a saved board post that could not be read fails the bookmarks read, with its retry", () => {
  const hook = read("src/features/board/use-board-posts-by-id.ts");
  assert.match(
    hook,
    /error: key\.length > 0 \? \(query\.error \?\? channels\.error \?\? null\) : null/,
  );
  assert.match(hook, /void query\.refetch\(\);\s+void channels\.refetch\(\);/);
  const page = read("src/features/social/ui/BookmarksPage.tsx");
  assert.match(
    page,
    /firstError\(ids\.error, notes\.error, boardPosts\.error\)/,
  );
  assert.match(page, /if \(boardPosts\.error\) boardPosts\.refetch\(\)/);
});

test("Explore's lists say when a later check failed above what loaded", () => {
  const source = read("src/features/social/ui/ExplorePage.tsx");
  assert.equal(source.match(/partialError\(view, error\)/g)?.length, 2);
  assert.match(source, /"social-trending-partial-error"/);
  assert.match(source, /"social-people-partial-error"/);
});

test("every page with timeline tabs ties the tabs to the panel they show", () => {
  const pages = {
    "src/features/social/ui/SocialHomePage.tsx": "home-tabs",
    "src/features/social/ui/ExplorePage.tsx": "explore-tabs",
    "src/features/social/ui/NotificationsPage.tsx": "notifications-tabs",
    "src/features/social/ui/SearchPage.tsx": "search-tabs",
    "src/features/feed/ui/ProfilePage.tsx": "profile-tabs",
  };
  for (const [path, base] of Object.entries(pages)) {
    const source = read(path);
    assert.match(source, new RegExp(`idBase="${base}"`), path);
    assert.match(
      source,
      new RegExp(`\\{\\.\\.\\.tabPanelProps\\("${base}", tab\\)\\}`),
      path,
    );
  }
});

test("scrolling lists stop at a failed older page and offer Try again", () => {
  const list = read("src/features/social/ui/PostList.tsx");
  assert.match(list, /moreState\(\{/);
  assert.match(list, /more !== "idle"/);
  assert.match(list, /data-testid="social-load-more-retry"/);
  const mixed = read("src/features/social/use-mixed-timeline.ts");
  // A failed older page of board posts is a load-more failure too, not the whole feed failing.
  assert.match(
    mixed,
    /loadMoreError: firstError\(olderPageError\(notes\), board\.olderError\)/,
  );
  const boardFeed = read("src/features/board/use-board-feed.ts");
  assert.match(
    boardFeed,
    /error: \(query\.isFetchNextPageError \? null : query\.error\) \?\? list\.error/,
  );
  assert.match(
    boardFeed,
    /olderError: query\.isFetchNextPageError \? query\.error : null/,
  );
  assert.match(mixed, /firstPageError\(notes\)/);
  for (const path of [
    "src/features/social/ui/SocialHomePage.tsx",
    "src/features/social/ui/HashtagPage.tsx",
    "src/features/feed/ui/ProfilePage.tsx",
  ]) {
    assert.match(read(path), /loadMoreError=\{/, path);
  }
});

test("a mute list that failed to read is unknown, not empty", () => {
  const failed = new Error("closed");
  // Failed with nothing read before: nobody may be shown from a list that leaves muted people out.
  assert.equal(readUnknown({ data: undefined, error: failed }), true);
  // Still loading, signed out (the read never runs), or read and empty: not a failure.
  assert.equal(readUnknown({ data: undefined, error: null }), false);
  assert.equal(readUnknown({ data: new Set(), error: null }), false);
  // A refresh failed but the earlier answer is still held: that answer is used.
  assert.equal(readUnknown({ data: new Set(["a"]), error: failed }), false);
});
