import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAddMemberEvent,
  buildCreateChannelEvent,
  canonicalChannelName,
  KIND_ADD_MEMBER,
  KIND_CREATE_CHANNEL,
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
