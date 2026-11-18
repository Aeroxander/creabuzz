// Wiki copilot policy: the two-tab answer loop cannot recur, each guard on its
// own, and end to end with two simulated agents.
// Run with: node --experimental-strip-types --test src/features/fleet/lib/wiki-copilot.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_REPLY_TAG,
  MAX_REPLIES_PER_PAGE_PER_HOUR,
  TASK_PATTERN,
  answerWikiEdit,
  buildReplyContent,
  createWikiCopilotPolicy,
  neutraliseTrigger,
  replyTags,
} from "./wiki-copilot.ts";

const HUMAN = "h".repeat(64);
const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);
const OLD_AGENT = "c".repeat(64);
const HOUR = 3_600_000;

let counter = 0;
function pageEvent({
  pubkey = HUMAN,
  slug = "standup",
  content = "@buzz-tab: summarise the week",
  tags = [],
} = {}) {
  counter += 1;
  return {
    id: `evt-${counter}`,
    pubkey,
    content,
    tags: [["d", slug], ...tags],
  };
}

function policyFor(self, { known = [], nowMs = () => 0, max } = {}) {
  return createWikiCopilotPolicy({
    selfPubkey: () => self,
    knownAgents: () => new Set(known),
    nowMs,
    maxRepliesPerHour: max,
  });
}

// ── guard 1: neutralise ───────────────────────────────────────────────────

test("the answered revision no longer starts with the trigger", () => {
  for (const content of [
    "@buzz-tab: what changed?",
    "@BUZZ-TAB : what changed?",
    "@buzz-tab:no space",
    "@buzz-tab\t:\nnext line",
  ]) {
    assert.equal(TASK_PATTERN.test(content), true, content);
    const reply = buildReplyContent(content, "It rained.");
    assert.equal(TASK_PATTERN.test(reply), false, content);
    assert.match(reply, /^> asked:/, content);
    assert.match(reply, /It rained\.$/);
  }
});

test("neutraliseTrigger keeps the question and quotes it", () => {
  assert.equal(
    neutraliseTrigger("@buzz-tab: what changed?\n\nnotes"),
    "> asked: what changed?\n\nnotes",
  );
  assert.equal(neutraliseTrigger("plain page"), "plain page");
});

test("a neutralised reply is not answered even by an unknown, untagged author", () => {
  // Guard 1 alone: no tag, author unknown to everyone.
  const policy = policyFor(AGENT_B);
  const reply = pageEvent({
    pubkey: OLD_AGENT,
    content: buildReplyContent("@buzz-tab: q", "a"),
  });
  assert.deepEqual(policy.decide(reply), {
    action: "skip",
    reason: "no-trigger",
  });
});

// ── guard 2: tag ──────────────────────────────────────────────────────────

test("copilot revisions carry the agent-reply tag", () => {
  assert.deepEqual(replyTags("standup"), [
    ["d", "standup"],
    ["agent-reply", "1"],
  ]);
  assert.deepEqual([...AGENT_REPLY_TAG], ["agent-reply", "1"]);
});

test("a tagged revision is never answered, even if it still holds a trigger", () => {
  // Guard 2 alone: trigger text present, author unknown, only the tag differs.
  const policy = policyFor(AGENT_B);
  const tagged = pageEvent({
    pubkey: OLD_AGENT,
    tags: [["agent-reply", "1"]],
  });
  assert.deepEqual(policy.decide(tagged), {
    action: "skip",
    reason: "agent-reply",
  });
  // And its author is remembered as an agent from then on.
  const untaggedLater = pageEvent({ pubkey: OLD_AGENT });
  assert.deepEqual(policy.decide(untaggedLater), {
    action: "skip",
    reason: "agent-author",
  });
});

// ── guard 3: known agents ─────────────────────────────────────────────────

test("a page authored by any known agent is never answered", () => {
  // Guard 3 alone: an older client keeps the trigger and adds no tag.
  const policy = policyFor(AGENT_B, { known: [OLD_AGENT, AGENT_A] });
  for (const pubkey of [OLD_AGENT, AGENT_A]) {
    assert.deepEqual(policy.decide(pageEvent({ pubkey })), {
      action: "skip",
      reason: "agent-author",
    });
  }
});

test("its own revisions are never answered", () => {
  const policy = policyFor(AGENT_B);
  assert.deepEqual(policy.decide(pageEvent({ pubkey: AGENT_B })), {
    action: "skip",
    reason: "own",
  });
});

test("a person's page with a trigger is answered", () => {
  const policy = policyFor(AGENT_B, { known: [AGENT_A] });
  const decision = policy.decide(pageEvent({ slug: "roadmap" }));
  assert.deepEqual(decision, {
    action: "reply",
    slug: "roadmap",
    instruction: "summarise the week",
  });
});

test("ordinary pages and pages without a slug are skipped", () => {
  const policy = policyFor(AGENT_B);
  assert.equal(
    policy.decide(pageEvent({ content: "just notes" })).reason,
    "no-trigger",
  );
  assert.equal(
    policy.decide({ id: "x", pubkey: HUMAN, content: "@buzz-tab: q", tags: [] })
      .reason,
    "no-slug",
  );
});

test("a replayed event is answered once", () => {
  const policy = policyFor(AGENT_B);
  const event = pageEvent();
  assert.equal(policy.decide(event).action, "reply");
  assert.deepEqual(policy.decide(event), {
    action: "skip",
    reason: "already-handled",
  });
});

// ── guard 4: budget ───────────────────────────────────────────────────────

test("replies per page per hour are bounded, and per page", () => {
  let now = 0;
  const policy = policyFor(AGENT_B, { nowMs: () => now });
  const decisions = [];
  for (let i = 0; i < MAX_REPLIES_PER_PAGE_PER_HOUR + 5; i += 1) {
    now += 1_000;
    decisions.push(policy.decide(pageEvent({ slug: "busy-page" })).action);
  }
  assert.equal(
    decisions.filter((action) => action === "reply").length,
    MAX_REPLIES_PER_PAGE_PER_HOUR,
  );
  // Another page has its own budget.
  assert.equal(
    policy.decide(pageEvent({ slug: "other-page" })).action,
    "reply",
  );
  // The window slides: an hour later the page can be answered again.
  now += HOUR + 1;
  assert.equal(policy.decide(pageEvent({ slug: "busy-page" })).action, "reply");
});

test("the budget reports itself as the reason", () => {
  const policy = policyFor(AGENT_B, { max: 1 });
  assert.equal(policy.decide(pageEvent()).action, "reply");
  assert.deepEqual(policy.decide(pageEvent()), {
    action: "skip",
    reason: "rate-limited",
  });
});

// ── the loop, end to end ──────────────────────────────────────────────────

/**
 * A relay shared by simulated tabs. Every published event is delivered to
 * every tab (as the wiki subscription does), including the publisher's own.
 */
function community() {
  const tabs = [];
  const log = [];
  const queue = [];
  const publish = (event) => {
    log.push(event);
    queue.push(event);
  };
  const addTab = (pubkey, knownAgents, options = {}) => {
    const policy = policyFor(pubkey, {
      known: knownAgents,
      nowMs: () => options.nowMs?.() ?? 0,
    });
    const tab = {
      pubkey,
      answered: 0,
      receive: (event) =>
        answerWikiEdit(policy, event, {
          ask: async ({ instruction }) => {
            tab.answered += 1;
            return `answer(${tab.pubkey.slice(0, 2)}): ${instruction.slice(0, 20)}`;
          },
          publish: async ({ slug, content, tags }) => {
            counter += 1;
            publish({ id: `rev-${counter}`, pubkey, content, tags: [...tags] });
            void slug;
          },
        }),
    };
    tabs.push(tab);
    return tab;
  };
  /** Deliver until quiet, or fail if it never is. */
  const run = async (limit = 200) => {
    let steps = 0;
    while (queue.length > 0) {
      steps += 1;
      assert.ok(steps <= limit, `still answering after ${limit} deliveries`);
      const event = queue.shift();
      for (const tab of tabs) await tab.receive(event);
    }
    return steps;
  };
  return { addTab, publish, run, log };
}

test("two members' tabs do not answer each other's pages", async () => {
  const relay = community();
  const a = relay.addTab(AGENT_A, [AGENT_B]);
  const b = relay.addTab(AGENT_B, [AGENT_A]);
  relay.publish(pageEvent({ content: "@buzz-tab: what shipped?" }));
  await relay.run();
  // Each tab answers the person once; neither answers the other's revision.
  assert.equal(a.answered, 1);
  assert.equal(b.answered, 1);
  const revisions = relay.log.filter((e) => e.pubkey !== HUMAN);
  assert.equal(revisions.length, 2);
  for (const revision of revisions) {
    assert.equal(TASK_PATTERN.test(revision.content), false);
    assert.ok(revision.tags.some((t) => t[0] === "agent-reply"));
  }
});

test("the loop is closed even when neither tab has heard of the other", async () => {
  // No roster entry for the other agent: only the neutralised trigger and the
  // tag stand between the tabs and the loop that used to run forever.
  const relay = community();
  const a = relay.addTab(AGENT_A, []);
  const b = relay.addTab(AGENT_B, []);
  relay.publish(pageEvent({ content: "@buzz-tab: what shipped?" }));
  await relay.run();
  assert.equal(a.answered + b.answered, 2);
});

test("an older client that keeps the trigger cannot start a loop with a current one", async () => {
  // OLD_AGENT publishes revisions the way the pre-fix client did: trigger kept,
  // no tag. It answers any page starting with the trigger but itself.
  const relay = community();
  const current = relay.addTab(AGENT_A, [OLD_AGENT]);
  let oldAnswers = 0;
  const oldClientReceive = async (event) => {
    if (event.pubkey === OLD_AGENT) return;
    if (!TASK_PATTERN.test(event.content)) return;
    oldAnswers += 1;
    relay.publish({
      id: `old-${oldAnswers}`,
      pubkey: OLD_AGENT,
      content: `${event.content}\n\n---\n> ✍️ buzz-tab\n\nold answer`,
      tags: [["d", event.tags.find((t) => t[0] === "d")[1]]],
    });
  };
  relay.publish(pageEvent({ content: "@buzz-tab: what shipped?" }));
  // Drive both: the current tab through the community, the old one by hand.
  for (let step = 0; step < 50; step += 1) {
    const before = relay.log.length;
    // deliver the newest events to both
    for (const event of relay.log.slice(-4)) {
      await oldClientReceive(event);
    }
    await relay.run();
    if (relay.log.length === before) break;
  }
  assert.ok(oldAnswers <= 3, `the old client answered ${oldAnswers} times`);
  assert.equal(current.answered, 1, "the current tab answers the person once");
});

test("a loop through an unknown path is bounded by the hourly budget", async () => {
  // Worst case: two agents that neutralise nothing, tag nothing and know
  // nobody, each answering the other's page. The budget is what stops them.
  let now = 0;
  const policyA = policyFor(AGENT_A, { nowMs: () => now });
  const policyB = policyFor(AGENT_B, { nowMs: () => now });
  const published = [];
  let event = pageEvent({ content: "@buzz-tab: ping" });
  for (let round = 0; round < 40; round += 1) {
    now += 1_000;
    let next = null;
    for (const [pubkey, policy] of [
      [AGENT_A, policyA],
      [AGENT_B, policyB],
    ]) {
      const decision = policy.decide(event);
      if (decision.action === "reply") {
        counter += 1;
        // A pre-fix reply: the trigger survives and nothing is tagged.
        next = {
          id: `loop-${counter}`,
          pubkey,
          content: `${event.content}\n\nreply`,
          tags: [["d", decision.slug]],
        };
        published.push(next);
      }
    }
    if (!next) break;
    event = next;
  }
  assert.ok(
    published.length <= 2 * MAX_REPLIES_PER_PAGE_PER_HOUR,
    `${published.length} replies in one hour`,
  );
});

test("production wiring: the browser agent answers wiki edits through the policy", () => {
  const source = readFileSync(
    new URL("../browser-agent.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /answerWikiEdit\(this\.wikiPolicy/);
  assert.match(source, /createWikiCopilotPolicy\(/);
  assert.match(source, /tags: draft\.tags/);
  // The old inline reply (trigger kept, untagged) is gone.
  assert.doesNotMatch(source, /\$\{event\.content\}\\n\\n---/);
  assert.doesNotMatch(source, /tags: \[\["d", slug\]\]/);
});
