import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateGettingStarted,
  gettingStartedDismissedKey,
  hasPostedMessage,
  hasRunWorkflow,
  pickFirstConversationalChannel,
} from "./gettingStarted.ts";

const SELF = "A".repeat(64);
const OTHER = "B".repeat(64);

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
    gettingStartedDismissedKey(SELF),
    gettingStartedDismissedKey(OTHER),
  );
  assert.equal(
    gettingStartedDismissedKey(` ${SELF.toUpperCase()} `),
    gettingStartedDismissedKey(SELF),
  );
});
