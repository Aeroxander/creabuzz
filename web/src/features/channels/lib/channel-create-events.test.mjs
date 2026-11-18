import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAddMemberEvent,
  buildRemoveMemberEvent,
  buildCreateChannelEvent,
  buildEditChannelEvent,
  canonicalChannelName,
  channelEdits,
  KIND_ADD_MEMBER,
  KIND_CREATE_CHANNEL,
  KIND_EDIT_CHANNEL,
} from "./channel-create-events.ts";
import {
  groupAgentsByTeam,
  planTemplateAttachments,
} from "./channel-templates.ts";

test("create-channel event matches the canonical create-group shape", () => {
  const event = buildCreateChannelEvent({
    id: "3b9f6f2e-6a1a-4a1a-9a1a-3b9f6f2e6a1a",
    name: "#general",
    visibility: "open",
    channelType: "stream",
    about: " Team talk ",
    ttlSeconds: 86_400,
  });
  assert.equal(event.kind, KIND_CREATE_CHANNEL);
  assert.equal(event.content, "");
  assert.deepEqual(event.tags, [
    ["h", "3b9f6f2e-6a1a-4a1a-9a1a-3b9f6f2e6a1a"],
    ["name", "general"],
    ["visibility", "open"],
    ["channel_type", "stream"],
    ["about", "Team talk"],
    ["ttl", "86400"],
  ]);
});

test("create-channel omits optional tags when unset", () => {
  const event = buildCreateChannelEvent({
    id: "3b9f6f2e-6a1a-4a1a-9a1a-3b9f6f2e6a1a",
    name: "general",
    visibility: "private",
  });
  assert.deepEqual(event.tags, [
    ["h", "3b9f6f2e-6a1a-4a1a-9a1a-3b9f6f2e6a1a"],
    ["name", "general"],
    ["visibility", "private"],
  ]);
});

test("create-channel rejects empty and hash-only names", () => {
  assert.throws(() =>
    buildCreateChannelEvent({
      id: "x",
      name: "  ###  ",
      visibility: "open",
    }),
  );
  assert.throws(() =>
    buildAddMemberEvent({ channelId: "x", pubkey: "not-hex" }),
  );
});

test("canonicalChannelName strips leading hashes and trims", () => {
  assert.equal(canonicalChannelName(" ## ops room "), "ops room");
});

test("add-member event matches the canonical shape with role", () => {
  const pubkey = "AB".repeat(32);
  const event = buildAddMemberEvent({
    channelId: "3b9f6f2e-6a1a-4a1a-9a1a-3b9f6f2e6a1a",
    pubkey,
    role: "bot",
  });
  assert.equal(event.kind, KIND_ADD_MEMBER);
  assert.equal(event.content, "");
  assert.deepEqual(event.tags, [
    ["h", "3b9f6f2e-6a1a-4a1a-9a1a-3b9f6f2e6a1a"],
    ["p", pubkey.toLowerCase()],
    ["role", "bot"],
  ]);
});

const roster = [
  { id: "a1", pubkey: "aa".repeat(32), name: "Ada", team: "core" },
  { id: "a2", pubkey: "bb".repeat(32), name: "Lin", team: "core" },
  { id: "a3", pubkey: "cc".repeat(32), name: "Mo", team: null },
];

test("all-agents seat plans every roster agent as a bot", () => {
  const template = {
    id: "t",
    name: "t",
    summary: "",
    channelType: "stream",
    visibility: "open",
    topic: "",
    seats: [{ type: "all-agents" }],
  };
  const { attachments, unresolvedSeats } = planTemplateAttachments(
    template,
    roster,
  );
  assert.equal(attachments.length, 3);
  assert.ok(attachments.every((a) => a.role === "bot"));
  assert.deepEqual(unresolvedSeats, []);
});

test("team seat resolves to the picked team's agents and reports misses", () => {
  const template = {
    id: "t",
    name: "t",
    summary: "",
    channelType: "stream",
    visibility: "private",
    topic: "",
    seats: [
      { type: "team", teamName: "" },
      { type: "agent", agentId: "gone" },
    ],
  };
  const { attachments, unresolvedSeats } = planTemplateAttachments(
    template,
    roster,
    { preferredTeamName: "core" },
  );
  assert.equal(attachments.length, 2);
  assert.deepEqual(attachments.map((a) => a.name).sort(), ["Ada", "Lin"]);
  assert.equal(unresolvedSeats.length, 1);
});

test("attachments dedupe by pubkey across seats", () => {
  const template = {
    id: "t",
    name: "t",
    summary: "",
    channelType: "stream",
    visibility: "open",
    topic: "",
    seats: [
      { type: "all-agents" },
      { type: "team", teamName: "core" },
      { type: "agent", agentId: "a1" },
    ],
  };
  const { attachments } = planTemplateAttachments(template, roster);
  assert.equal(attachments.length, 3);
});

test("groupAgentsByTeam buckets unteamed agents under the empty key", () => {
  const groups = groupAgentsByTeam(roster);
  assert.equal(groups.get("core")?.length, 2);
  assert.equal(groups.get("")?.length, 1);
});

test("removing someone names the room and the person, nothing else", () => {
  const pubkey = "AB".repeat(32);
  assert.deepEqual(buildRemoveMemberEvent({ channelId: "room", pubkey }), {
    kind: 9001,
    content: "",
    tags: [
      ["h", "room"],
      ["p", pubkey.toLowerCase()],
    ],
  });
  assert.throws(() =>
    buildRemoveMemberEvent({ channelId: "room", pubkey: "not-hex" }),
  );
});

const ROOM = "1b6f9d7e-3c2a-4b8e-9f10-0a1b2c3d4e5f";

test("edit-channel event matches the canonical edit-metadata shape (build_update_channel)", () => {
  assert.equal(KIND_EDIT_CHANNEL, 9002);
  assert.deepEqual(
    buildEditChannelEvent({
      channelId: ROOM,
      name: "  ##design-review ",
      about: "  Talk about the designs  ",
      visibility: "private",
    }),
    {
      kind: 9002,
      content: "",
      tags: [
        ["h", ROOM],
        ["name", "design-review"],
        ["about", "Talk about the designs"],
        ["visibility", "private"],
      ],
    },
  );
  // Only what changes is sent; an empty description clears it.
  assert.deepEqual(
    buildEditChannelEvent({ channelId: ROOM, about: " " }).tags,
    [
      ["h", ROOM],
      ["about", ""],
    ],
  );
});

test("edit-channel refuses an empty name, an unknown visibility and an edit with nothing in it", () => {
  assert.throws(
    () => buildEditChannelEvent({ channelId: ROOM, name: " # " }),
    /name is required/,
  );
  assert.throws(
    () => buildEditChannelEvent({ channelId: ROOM, visibility: "public" }),
    /visibility/,
  );
  assert.throws(
    () => buildEditChannelEvent({ channelId: ROOM }),
    /nothing to change/,
  );
});

test("channelEdits sends only what differs from the room as it is", () => {
  const current = {
    name: "general",
    description: "Hello",
    visibility: "public",
  };
  assert.equal(
    channelEdits(current, {
      name: " #general ",
      description: "Hello ",
      visibility: "open",
    }),
    null,
  );
  assert.deepEqual(
    channelEdits(current, {
      name: "chat",
      description: "Hello",
      visibility: "open",
    }),
    { name: "chat" },
  );
  assert.deepEqual(
    channelEdits(current, {
      name: "general",
      description: "",
      visibility: "private",
    }),
    { about: "", visibility: "private" },
  );
  assert.deepEqual(
    channelEdits(
      { ...current, visibility: "private" },
      { name: "general", description: "Hello", visibility: "open" },
    ),
    { visibility: "open" },
  );
});
