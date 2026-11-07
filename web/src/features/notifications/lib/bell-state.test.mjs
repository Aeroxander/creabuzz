import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bellState } from "./bell-state.ts";

const FAILED = new Error("socket closed");

test("a poll that failed before anything was read is a failure, never Nothing new", () => {
  assert.deepEqual(
    bellState({ data: undefined, error: FAILED, isLoading: false }),
    { view: "error", stale: false },
  );
});

test("a failed later poll keeps the last good list and says it may be out of date", () => {
  assert.deepEqual(
    bellState({ data: [{ at: 1 }], error: FAILED, isLoading: false }),
    { view: "list", stale: true },
  );
  assert.deepEqual(bellState({ data: [], error: FAILED, isLoading: false }), {
    view: "empty",
    stale: true,
  });
});

test("an answered poll with nothing is Nothing new; one not yet answered is loading", () => {
  assert.deepEqual(bellState({ data: [], error: null, isLoading: false }), {
    view: "empty",
    stale: false,
  });
  assert.deepEqual(
    bellState({ data: undefined, error: null, isLoading: true }),
    { view: "loading", stale: false },
  );
});

test("the bell reads the poll's state, and only an answered empty poll says Nothing new", () => {
  const bell = readFileSync(
    new URL("../ui/NotificationBell.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL("../use-notifications.ts", import.meta.url),
    "utf8",
  );
  assert.match(hook, /bellState\(\{/);
  assert.match(bell, /data-testid="notifications-bell-error"/);
  assert.match(bell, /onClick=\{retry\}/);
  // "Nothing new." sits behind the error branch, not straight behind an empty item list.
  assert.match(bell, /view === "error" \? null : items\.length === 0/);
});
