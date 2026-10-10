/**
 * Template apply: the plan (what to write, what to skip), and the exact record
 * each step publishes. The org, budget and marker shapes are the ones the
 * command line's engine writes (crates/buzz-cli/src/commands/templates/apply.rs
 * tests pin the same facts), so the two can finish each other's work.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStepEvent,
  channelIdOf,
  describeStep,
  emptyExisting,
  itemKey,
  marker,
  markerItem,
  nextCreatedAt,
  planApply,
  seedItem,
} from "./apply.ts";
import { TEMPLATE_CATALOG } from "./catalog.generated.ts";
import { TEMPLATE_INDEX } from "./catalog-index.generated.ts";
import { validateTemplate } from "./schema.ts";

const ME = "a".repeat(64);
const SKILL_TEXT = "---\nname: craft\ndescription: how to craft\n---\nbody";

/** A small template that uses every kind of step. */
function demo() {
  return {
    template: {
      id: "demo",
      name: "Demo",
      description: "A demo.",
      channels: [
        {
          id: "room",
          name: "#Room",
          purpose: "The room.",
          seed: "seeds/room.md",
        },
        { id: "desk", name: "desk", purpose: "The desk." },
      ],
      personas: [
        { id: "writer", name: "The Writer", prompt: "personas/writer.md" },
        {
          id: "editor",
          name: "The Editor",
          prompt: "personas/editor.md",
          skills: [],
        },
      ],
      workflows: [{ file: "workflows/nightly-standup.yaml", channel: "desk" }],
      docs: [{ file: "docs/story-bible.md", title: "Story Bible" }],
      skills: [
        {
          name: "craft",
          source: "skills/craft/SKILL.md",
          applies_to: "developers",
        },
        {
          name: "remote",
          source: "https://example.com/SKILL.md",
          applies_to: "all",
        },
      ],
      welcome: "welcome.md",
      org: {
        root: { name: "Studio", blurb: "The founders" },
        seats: [
          { persona: "writer", title: "Head of Story" },
          { persona: "editor" },
        ],
        default_budget: {
          window: "week",
          runs: 200,
          tasks_create: 20,
          messages: 300,
        },
      },
    },
    files: {
      "seeds/room.md": "Say what you are making.",
      "personas/writer.md": "You write.",
      "personas/editor.md": "You edit.",
      "workflows/nightly-standup.yaml": "name: standup\n",
      "docs/story-bible.md": "# Story Bible\n",
      "skills/craft/SKILL.md": SKILL_TEXT,
      "welcome.md": "Welcome.",
    },
    skills: {
      craft: {
        name: "craft",
        description: "how to craft",
        sha256: "f".repeat(64),
        content: SKILL_TEXT,
      },
    },
  };
}

function ctx(entry, over = {}) {
  let n = 0;
  return {
    entry,
    channelIds: { room: "room-uuid", desk: "desk-uuid" },
    me: ME,
    now: 1000,
    newId: () => `uuid-${++n}`,
    ...over,
  };
}

function step(plan, kind, item) {
  const found = plan.find((s) => s.kind === kind && s.item === item);
  assert.ok(found, `no ${kind} step ${item}`);
  return found;
}

test("a fresh plan runs channels, skills, helpers, the organization, workflows, pages, then the welcome", () => {
  const plan = planApply(demo(), emptyExisting());
  assert.deepEqual(
    plan.map((s) => `${s.kind}:${s.item}`),
    [
      "channel:room",
      "seed:seed:room",
      "channel:desk",
      "skill:craft",
      "skill:remote",
      "persona:writer",
      "persona:editor",
      "org:org:root",
      "org:org:seat:writer",
      "org:org:seat:editor",
      "org:org:budget",
      "workflow:workflows/nightly-standup.yaml",
      "doc:docs/story-bible.md",
      "welcome:welcome",
    ],
  );
  // Everything is a write except the skill this app cannot fetch.
  assert.deepEqual(
    plan
      .filter((s) => s.action !== "create")
      .map((s) => `${s.item}=${s.action}`),
    ["remote=needs-cli"],
  );
});

test("what the server already holds is skipped, so applying again or resuming writes only the rest", () => {
  const existing = emptyExisting();
  existing.channels.set("Room", "chan-1");
  existing.items.set(itemKey("persona", "writer"), {
    eventId: "e1",
    createdAt: 5,
  });
  existing.items.set(itemKey("welcome", "welcome"), {
    eventId: "e2",
    createdAt: 6,
  });
  existing.items.set(itemKey("skill", "craft"), {
    eventId: "e3",
    createdAt: 7,
    source: "skills/craft/SKILL.md",
  });
  existing.orgNodes.add("root");
  existing.orgBudgets.add("default-agents");
  const plan = planApply(demo(), existing);
  const action = (kind, item) => step(plan, kind, item).action;
  // The channel name matches without the leading "#".
  assert.equal(action("channel", "room"), "already-exists");
  assert.equal(action("channel", "desk"), "create");
  assert.equal(action("persona", "writer"), "already-exists");
  assert.equal(action("persona", "editor"), "create");
  assert.equal(action("welcome", "welcome"), "already-exists");
  assert.equal(action("skill", "craft"), "unchanged");
  assert.equal(action("org", "org:root"), "already-exists");
  assert.equal(action("org", "org:seat:writer"), "create");
  assert.equal(action("org", "org:budget"), "already-exists");
});

test("a skill recorded with a different source is written again", () => {
  const existing = emptyExisting();
  existing.items.set(itemKey("skill", "craft"), {
    eventId: "e",
    createdAt: 1,
    source: "skills/older/SKILL.md",
  });
  assert.equal(
    step(planApply(demo(), existing), "skill", "craft").action,
    "create",
  );
});

test("the markers and the replaceable-record clock", () => {
  assert.deepEqual(marker("demo", "persona-x"), ["t", "demo", "persona-x"]);
  assert.equal(seedItem("room"), "seed:room");
  // A re-publish always beats the record it replaces, even in the same second.
  assert.equal(nextCreatedAt(1000), 1000);
  assert.equal(nextCreatedAt(1000, 500), 1000);
  assert.equal(nextCreatedAt(1000, 1000), 1001);
  assert.equal(nextCreatedAt(1000, 2000), 2001);
  assert.equal(
    markerItem(
      [
        ["h", "x"],
        ["t", "other", "a"],
        ["t", "demo", "org:root"],
      ],
      "demo",
    ),
    "org:root",
  );
  assert.equal(markerItem([["t", "other", "a"]], "demo"), null);
});

test("a channel is an open stream channel with its purpose, and the first message follows it", () => {
  const entry = demo();
  const channel = buildStepEvent(
    { kind: "channel", item: "room", action: "create" },
    ctx(entry),
  );
  assert.equal(channel.kind, 9007);
  assert.equal(channel.content, "");
  assert.deepEqual(channel.tags, [
    ["h", "uuid-1"],
    ["name", "Room"],
    ["visibility", "open"],
    ["channel_type", "stream"],
    ["about", "The room."],
  ]);
  assert.equal(channelIdOf(channel), "uuid-1");

  const seed = buildStepEvent(
    { kind: "seed", item: "seed:room", action: "create" },
    ctx(entry),
  );
  assert.equal(seed.kind, 9);
  assert.equal(seed.content, "Say what you are making.");
  assert.deepEqual(seed.tags, [
    ["h", "room-uuid"],
    ["t", "demo", "seed:room"],
  ]);
});

test("the welcome goes to the first channel", () => {
  const welcome = buildStepEvent(
    { kind: "welcome", item: "welcome", action: "create" },
    ctx(demo()),
  );
  assert.equal(welcome.kind, 9);
  assert.equal(welcome.content, "Welcome.");
  assert.deepEqual(welcome.tags, [
    ["h", "room-uuid"],
    ["t", "demo", "welcome"],
  ]);
});

test("a helper is a persona record: its name and prompt, with only the skills this app publishes bound", () => {
  const entry = demo();
  const writer = buildStepEvent(
    { kind: "persona", item: "writer", action: "create" },
    ctx(entry),
  );
  assert.equal(writer.kind, 30175);
  assert.deepEqual(JSON.parse(writer.content), {
    display_name: "The Writer",
    system_prompt: "You write.",
  });
  // The remote skill is not bundled, so it is not bound.
  assert.deepEqual(writer.tags, [
    ["d", "writer"],
    ["skill", "craft", "developers"],
    ["t", "demo", "writer"],
  ]);
  // A helper that lists no skills inherits none.
  const editor = buildStepEvent(
    { kind: "persona", item: "editor", action: "create" },
    ctx(entry),
  );
  assert.deepEqual(editor.tags, [
    ["d", "editor"],
    ["t", "demo", "editor"],
  ]);
});

test("a skill record pins its text and remembers where it came from", () => {
  const skill = buildStepEvent(
    { kind: "skill", item: "craft", action: "create" },
    ctx(demo()),
  );
  assert.equal(skill.kind, 30180);
  assert.deepEqual(JSON.parse(skill.content), {
    name: "craft",
    description: "how to craft",
    sha256: "f".repeat(64),
    content: SKILL_TEXT,
    attachments: [],
  });
  assert.deepEqual(skill.tags, [
    ["d", "craft"],
    ["t", "demo", "craft"],
    ["sha256", "f".repeat(64)],
    ["source", "skills/craft/SKILL.md"],
    ["applies_to", "developers"],
  ]);
  assert.throws(
    () =>
      buildStepEvent(
        { kind: "skill", item: "remote", action: "create" },
        ctx(demo()),
      ),
    /not bundled/,
  );
});

test("a workflow is bound to its channel, and a page is a wiki page named for its file", () => {
  const entry = demo();
  const workflow = buildStepEvent(
    {
      kind: "workflow",
      item: "workflows/nightly-standup.yaml",
      action: "create",
    },
    ctx(entry),
  );
  assert.equal(workflow.kind, 30620);
  assert.equal(workflow.content, "name: standup\n");
  // Bound to the channel it names, not the first one.
  assert.deepEqual(workflow.tags, [
    ["d", "uuid-1"],
    ["h", "desk-uuid"],
    ["t", "demo", "workflows/nightly-standup.yaml"],
  ]);
  const page = buildStepEvent(
    { kind: "doc", item: "docs/story-bible.md", action: "create" },
    ctx(entry),
  );
  assert.equal(page.kind, 44001);
  assert.equal(page.content, "# Story Bible\n");
  assert.deepEqual(page.tags, [
    ["d", "story-bible"],
    ["t", "demo", "docs/story-bible.md"],
  ]);
});

test("the founder seat is a role node held by the signer, with no parent", () => {
  const root = buildStepEvent(
    { kind: "org", item: "org:root", action: "create" },
    ctx(demo()),
  );
  assert.equal(root.kind, 37010);
  assert.deepEqual(root.tags, [
    ["d", "root"],
    ["name", "Studio"],
    ["seat", ME],
    ["t", "demo", "org:root"],
  ]);
  const body = JSON.parse(root.content);
  assert.equal(body.kind, "role");
  assert.deepEqual(body.holders, [ME]);
  assert.equal("parent" in body, false);
  assert.deepEqual(body.scope.canGrant, ["read", "task"]);
  assert.equal(body.ui.blurb, "The founders");
  // The exact bytes the command line's serializer writes (key order included).
  assert.equal(
    root.content,
    `{"v":1,"name":"Studio","kind":"role","holders":["${ME}"],"agentSeats":[],"scope":{"readBelow":true,"assignBelow":true,"canGrant":["read","task"]},"ui":{"blurb":"The founders"}}`,
  );
});

test("a helper's seat is vacant, under the founder seat, with the declared title or the helper's name", () => {
  const entry = demo();
  const titled = buildStepEvent(
    { kind: "org", item: "org:seat:writer", action: "create" },
    ctx(entry),
  );
  assert.deepEqual(titled.tags[0], ["d", "seat-writer"]);
  const body = JSON.parse(titled.content);
  assert.equal(body.name, "Head of Story");
  assert.equal(body.kind, "agent_seat");
  assert.equal(body.parent, "root");
  assert.deepEqual(body.holders, []);
  assert.deepEqual(body.agentSeats, []);
  const plain = buildStepEvent(
    { kind: "org", item: "org:seat:editor", action: "create" },
    ctx(entry),
  );
  assert.equal(JSON.parse(plain.content).name, "The Editor");
});

test("the default budget covers every helper, with only the declared limits", () => {
  const budget = buildStepEvent(
    { kind: "org", item: "org:budget", action: "create" },
    ctx(demo()),
  );
  assert.equal(budget.kind, 37012);
  assert.deepEqual(budget.tags, [
    ["d", "default-agents"],
    ["t", "demo", "org:budget"],
  ]);
  assert.equal(
    budget.content,
    '{"v":1,"subject":"*","window":"week","limits":{"runs":200,"tasks":{"create":20},"messages":300},"onExceed":"require-approval"}',
  );
});

test("a record that replaces an earlier one is stamped after it", () => {
  const welcome = buildStepEvent(
    { kind: "welcome", item: "welcome", action: "create" },
    ctx(demo(), { prior: 5000 }),
  );
  assert.equal(welcome.created_at, 5001);
});

test("a step for something the template does not have fails loudly", () => {
  const entry = demo();
  assert.throws(
    () =>
      buildStepEvent(
        { kind: "persona", item: "nobody", action: "create" },
        ctx(entry),
      ),
    /no helper/,
  );
  assert.throws(
    () =>
      buildStepEvent(
        { kind: "seed", item: "seed:room", action: "create" },
        ctx(entry, { channelIds: {} }),
      ),
    /was not created/,
  );
  entry.files["welcome.md"] = undefined;
  assert.throws(
    () =>
      buildStepEvent(
        { kind: "welcome", item: "welcome", action: "create" },
        ctx(entry),
      ),
    /missing/,
  );
});

test("steps are described in words a person would use", () => {
  const entry = demo();
  const say = (kind, item) =>
    describeStep(entry, { kind, item, action: "create" });
  assert.equal(say("channel", "room"), "Create #Room");
  assert.equal(say("seed", "seed:room"), "First message in #Room");
  assert.equal(say("persona", "writer"), "Helper: The Writer");
  assert.equal(say("org", "org:root"), "Your team: Studio");
  assert.equal(say("org", "org:seat:writer"), "Seat for The Writer");
  assert.equal(say("org", "org:budget"), "A default limit for helpers");
  assert.equal(
    say("workflow", "workflows/nightly-standup.yaml"),
    "Automation: nightly standup",
  );
  assert.equal(say("doc", "docs/story-bible.md"), "Page: Story Bible");
  assert.equal(say("welcome", "welcome"), "Welcome message");
});

test("validation names every way a template breaks the contract", () => {
  assert.deepEqual(validateTemplate(demo()), []);
  const broken = demo();
  broken.template.channels[0].seed = "seeds/missing.md";
  broken.template.personas[0].skills = ["nope"];
  broken.template.workflows[0].channel = "nowhere";
  broken.template.org.seats[0].persona = "ghost";
  broken.template.org.default_budget.runs = 0;
  const problems = validateTemplate(broken).join("\n");
  assert.match(problems, /seeds\/missing\.md is missing/);
  assert.match(problems, /unknown skill nope/);
  assert.match(problems, /unknown channel nowhere/);
  assert.match(problems, /unknown persona ghost/);
  assert.match(problems, /default_budget runs/);
});

test("every bundled template is valid, applies cleanly from nothing, and is in the picker", () => {
  const ids = Object.keys(TEMPLATE_CATALOG);
  assert.deepEqual(TEMPLATE_INDEX.map((t) => t.id).sort(), [...ids].sort());
  for (const id of ids) {
    const entry = TEMPLATE_CATALOG[id];
    assert.deepEqual(validateTemplate(entry), [], id);
    const plan = planApply(entry, emptyExisting());
    // Build every step the way the runner does: channels first, so later
    // steps find their channel.
    const channelIds = {};
    let n = 0;
    const base = { entry, me: ME, now: 1000, newId: () => `id-${++n}` };
    for (const planned of plan) {
      if (planned.action !== "create") continue;
      const draft = buildStepEvent(planned, { ...base, channelIds });
      if (planned.kind === "channel")
        channelIds[planned.item] = channelIdOf(draft);
      assert.ok(
        draft.kind > 0 && Array.isArray(draft.tags),
        `${id} ${planned.kind} ${planned.item}`,
      );
    }
    assert.ok(
      channelIds[entry.template.channels[0].id],
      `${id}: first channel`,
    );
  }
});
