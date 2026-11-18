import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateGettingStarted,
  gettingStartedDismissedKey,
  hasPostedMessage,
  hasRunWorkflow,
  pickFirstConversationalChannel,
  readGettingStartedDismissed,
  writeGettingStartedDismissed,
} from "./gettingStarted.ts";

const SELF = "A".repeat(64);
const OTHER = "B".repeat(64);
const RELAY_A = "wss://alpha.example.com";
const RELAY_B = "wss://beta.example.com";

function feedItem(overrides = {}) {
  return {
    id: "evt-1",
    kind: 40002,
    pubkey: SELF,
    content: "hello",
    createdAt: 1,
    channelId: "channel-1",
    channelName: "general",
    tags: [],
    category: "activity",
    ...overrides,
  };
}

function channel(overrides = {}) {
  return {
    id: "channel-1",
    name: "general",
    channelType: "text",
    ...overrides,
  };
}

function stepById(steps, id) {
  const step = steps.find((entry) => entry.id === id);
  assert.ok(step, `missing step ${id}`);
  return step;
}

function input(overrides = {}) {
  return {
    channels: [],
    feedItems: [],
    managedAgentCount: 0,
    currentPubkey: SELF,
    ...overrides,
  };
}

test("open-channel step detects any channel in the store", () => {
  const todo = stepById(evaluateGettingStarted(input()), "open-channel");
  assert.equal(todo.state, "todo");
  assert.equal(todo.action.kind, "create-channel");

  const done = stepById(
    evaluateGettingStarted(input({ channels: [channel()] })),
    "open-channel",
  );
  assert.equal(done.state, "done");
  assert.equal(done.action.kind, "browse-channels");
});

test("say-hello step only flips done for own message-kind items", () => {
  // A reminder authored by the user is not "saying hello" (no false done).
  const reminder = feedItem({ kind: 40007, category: "reminders" });
  assert.equal(hasPostedMessage([reminder], SELF), false);

  // Someone else's message is not the user's hello either.
  const theirs = feedItem({ pubkey: OTHER });
  assert.equal(hasPostedMessage([theirs], SELF), false);

  const mine = feedItem();
  assert.equal(hasPostedMessage([mine], SELF), true);

  const done = stepById(
    evaluateGettingStarted(input({ feedItems: [reminder, mine] })),
    "say-hello",
  );
  assert.equal(done.state, "done");
});

test("say-hello step needs a known pubkey before it can claim done", () => {
  // Without currentPubkey nothing may be claimed done (Rule 1).
  const steps = evaluateGettingStarted(
    input({ currentPubkey: undefined, feedItems: [feedItem()] }),
  );
  assert.equal(stepById(steps, "say-hello").state, "todo");
});

test("mention-agent step renders as an action link, never a checkbox", () => {
  const step = stepById(evaluateGettingStarted(input()), "mention-agent");
  assert.equal(step.state, "undetected");
  assert.ok(step.actionLabel.length > 0);
});

test("add-agent step detects managed agents", () => {
  assert.equal(
    stepById(evaluateGettingStarted(input()), "add-agent").state,
    "todo",
  );
  assert.equal(
    stepById(
      evaluateGettingStarted(input({ managedAgentCount: 2 })),
      "add-agent",
    ).state,
    "done",
  );
});

test("run-workflow step only flips done for own job events", () => {
  // A job request targeting the user's agent is authored by someone else.
  const theirJob = feedItem({ kind: 43001, pubkey: OTHER });
  assert.equal(hasRunWorkflow([theirJob], SELF), false);

  const myJob = feedItem({ kind: 43001 });
  assert.equal(hasRunWorkflow([myJob], SELF), true);

  const done = stepById(
    evaluateGettingStarted(input({ feedItems: [myJob] })),
    "run-workflow",
  );
  assert.equal(done.state, "done");
  assert.equal(done.action.kind, "open-workflows");
});

test("channel affordances prefer a non-DM channel", () => {
  assert.equal(pickFirstConversationalChannel([]), null);
  assert.equal(
    pickFirstConversationalChannel([channel({ channelType: "dm" })]),
    null,
  );
  const picked = pickFirstConversationalChannel([
    channel({ id: "dm-1", channelType: "dm" }),
    channel({ id: "chan-2" }),
  ]);
  assert.equal(picked?.id, "chan-2");

  const step = stepById(
    evaluateGettingStarted(
      input({
        channels: [
          channel({ id: "dm-1", channelType: "dm" }),
          channel({ id: "chan-2" }),
        ],
      }),
    ),
    "say-hello",
  );
  assert.deepEqual(step.action, { kind: "open-channel", channelId: "chan-2" });
});

test("dismissal key is scoped per identity", () => {
  assert.notEqual(
    gettingStartedDismissedKey(RELAY_A, SELF),
    gettingStartedDismissedKey(RELAY_A, OTHER),
  );
  assert.equal(
    gettingStartedDismissedKey(RELAY_A, ` ${SELF.toUpperCase()} `),
    gettingStartedDismissedKey(RELAY_A, SELF),
  );
});

test("dismissal key is scoped per community", () => {
  // The same identity dismissing the checklist in one community must not hide
  // it in another, where its steps are different and still undone.
  assert.notEqual(
    gettingStartedDismissedKey(RELAY_A, SELF),
    gettingStartedDismissedKey(RELAY_B, SELF),
  );
  // One community, however its URL was typed.
  assert.equal(
    gettingStartedDismissedKey(` ${RELAY_A.toUpperCase()}/ `, SELF),
    gettingStartedDismissedKey(RELAY_A, SELF),
  );
  // Not the pre-fix identity-only key.
  assert.doesNotMatch(gettingStartedDismissedKey(RELAY_A, SELF), /\.v1:/);
});

test("dismissal state does not leak across communities in storage", () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
  try {
    writeGettingStartedDismissed(RELAY_A, SELF, true);
    assert.equal(readGettingStartedDismissed(RELAY_A, SELF), true);
    assert.equal(readGettingStartedDismissed(RELAY_B, SELF), false);
    assert.equal(readGettingStartedDismissed(RELAY_A, OTHER), false);
    writeGettingStartedDismissed(RELAY_A, SELF, false);
    assert.equal(readGettingStartedDismissed(RELAY_A, SELF), false);
    // A dismissal written under the old identity-only key is not honoured.
    store.set(`buzz-getting-started-dismissed.v1:${SELF}`, "1");
    assert.equal(readGettingStartedDismissed(RELAY_B, SELF), false);
  } finally {
    delete globalThis.window;
  }
});

test("the hook scopes dismissal by the active community", () => {
  const source = readFileSync(
    new URL("../useGettingStartedDismissal.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /useCommunities\(\)/);
  assert.match(source, /activeCommunity\?\.relayUrl/);
  assert.match(source, /readGettingStartedDismissed\(communityScope/);
});
