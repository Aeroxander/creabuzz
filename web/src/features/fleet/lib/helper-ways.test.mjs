import test from "node:test";
import assert from "node:assert/strict";

import { describeWays } from "./helper-ways.ts";

const idle = { state: "stopped", name: null };
const way = (ways, id) => ways.find((w) => w.id === id);

test("the three ways are always offered, in the order a newcomer should look at them", () => {
  const ways = describeWays({ gateway: "available", tab: idle, helpers: [] });
  assert.deepEqual(
    ways.map((w) => w.id),
    ["tab", "server", "computer"],
  );
  assert.ok(ways.every((w) => w.title && w.summary && w.status));
});

test("the tab way works only where the server has an AI service, and says so when it does not", () => {
  const ready = way(
    describeWays({ gateway: "available", tab: idle, helpers: [] }),
    "tab",
  );
  assert.deepEqual([ready.state, ready.status], ["ready", "Ready to start."]);
  const missing = way(
    describeWays({ gateway: "missing", tab: idle, helpers: [] }),
    "tab",
  );
  assert.equal(missing.state, "unavailable");
  assert.match(missing.status, /no AI service set up/);
  assert.equal(
    way(describeWays({ gateway: "unknown", tab: idle, helpers: [] }), "tab")
      .state,
    "unknown",
  );
  // A helper that is already running is running, whatever the check said.
  const running = way(
    describeWays({
      gateway: "missing",
      tab: { state: "running", name: "The Writer" },
      helpers: [],
    }),
    "tab",
  );
  assert.deepEqual(
    [running.state, running.status],
    ["running", "The Writer is running in this tab."],
  );
});

test("the server way reports what is running there, and what is set up but offline", () => {
  const helper = (name, runtype, alive) => ({ name, runtype, alive });
  const none = way(
    describeWays({
      gateway: "available",
      tab: idle,
      helpers: [helper("Tab", "browser", true)],
    }),
    "server",
  );
  assert.equal(none.state, "unavailable");
  assert.match(none.status, /Nothing is running on this server yet/);
  const live = way(
    describeWays({
      gateway: "available",
      tab: idle,
      helpers: [helper("Worker", "sandbox", true)],
    }),
    "server",
  );
  assert.deepEqual(
    [live.state, live.status],
    ["running", "Worker is running on this server."],
  );
  const offline = way(
    describeWays({
      gateway: "available",
      tab: idle,
      helpers: [helper("Worker", "sandbox", false)],
    }),
    "server",
  );
  assert.equal(offline.state, "unavailable");
  assert.match(offline.status, /Worker is set up on this server but offline/);
  const many = way(
    describeWays({
      gateway: "available",
      tab: idle,
      helpers: [
        helper("A", "sandbox", true),
        helper("B", "sandbox", true),
        helper("C", "sandbox", true),
      ],
    }),
    "server",
  );
  assert.equal(many.status, "A, B and 1 more are running on this server.");
});

test("the computer way is offered unless someone is already using it", () => {
  const helper = (name, alive) => ({ name, runtype: "desktop", alive });
  assert.deepEqual(
    [
      way(
        describeWays({ gateway: "available", tab: idle, helpers: [] }),
        "computer",
      ).state,
      way(
        describeWays({
          gateway: "available",
          tab: idle,
          helpers: [helper("Ana", false)],
        }),
        "computer",
      ).state,
      way(
        describeWays({
          gateway: "available",
          tab: idle,
          helpers: [helper("Ana", true)],
        }),
        "computer",
      ).state,
    ],
    ["ready", "ready", "running"],
  );
  assert.equal(
    way(
      describeWays({
        gateway: "available",
        tab: idle,
        helpers: [helper("Ana", true)],
      }),
      "computer",
    ).status,
    "Ana is running from a computer.",
  );
});
