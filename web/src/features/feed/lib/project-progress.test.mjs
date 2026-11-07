import assert from "node:assert/strict";
import { test } from "node:test";
import {
  progressArtifacts,
  projectProgress,
  parseSeenProgress,
  rememberProgress,
} from "./project-progress.ts";

test("artifact links are explicit, bounded and never include credentials", () => {
  assert.deepEqual(
    progressArtifacts(
      "Demo: https://example.com/demo. Secret: https://user:pass@example.com",
    ),
    ["https://example.com/demo"],
  );
  assert.equal(
    progressArtifacts(
      Array.from({ length: 10 }, (_, n) => `https://example.com/${n}`).join(
        " ",
      ),
    ).length,
    3,
  );
});
import { buildLaunchUpdate } from "../../social/lib/launch-update.ts";
import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";

const founder = "a".repeat(64),
  teammate = "b".repeat(64),
  stranger = "c".repeat(64);
const launch = {
  record: {
    id: "same-slug",
    author: founder,
    name: "Project",
    team: [{ pubkey: teammate }],
  },
  updates: [],
};
const note = (id, pubkey, at = 10) => ({
  ...buildLaunchUpdate({
    text: "A working demo",
    launch: { id: "same-slug", pubkey: founder },
  }),
  id,
  pubkey,
  created_at: at,
});

test("progress accepts both signed team formats, not a stranger's team label", () => {
  const items = projectProgress(
    [
      {
        ...launch,
        updates: [
          {
            id: "old",
            author: founder,
            createdAt: 4,
            title: "Release",
            body: "An artifact",
          },
          {
            id: "fake",
            author: stranger,
            createdAt: 20,
            title: "Paid!",
            body: "Untrusted",
          },
          {
            id: "evidence",
            author: stranger,
            createdAt: 5,
            title: "My work",
            body: "Proof submitted",
            claim: { id: "claim" },
          },
        ],
      },
    ],
    [note("new", teammate), note("spoof", stranger, 30)],
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ["new", "old"],
  );
  assert.equal(items[1].evidence, false);
  assert.equal(items[1].event.kind, KIND_LAUNCH_UPDATE);
  assert.equal(items[0].text, "A working demo");
});

test("same-slug projects remain author-qualified and duplicate reports render once", () => {
  const other = {
    record: { ...launch.record, author: stranger, name: "Other", team: [] },
    updates: [],
  };
  const items = projectProgress(
    [launch, other],
    [note("one", founder), note("one", founder)],
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].project.author, founder);
});

test("reading history preserves old IDs and does not treat a late-arriving report as read", () => {
  const seen = rememberProgress({}, "account/relay/project", ["newer"], 10);
  const next = rememberProgress(seen, "account/relay/project", ["newest"], 20);
  assert.deepEqual(next["account/relay/project"].ids, ["newest", "newer"]);
  assert.equal(
    next["account/relay/project"].ids.includes("late-arrival"),
    false,
  );
  assert.equal(next["other-account/relay/project"], undefined);
});

test("corrupt reading state is recoverable and history is bounded", () => {
  assert.deepEqual(parseSeenProgress("broken"), {});
  assert.deepEqual(parseSeenProgress('{"bad":{"ids":42}}'), {});
  let seen = {};
  for (let n = 0; n < 80; n++)
    seen = rememberProgress(
      seen,
      `p${n}`,
      Array.from({ length: 300 }, (_, i) => String(i)),
      n,
    );
  assert.equal(Object.keys(seen).length, 50);
  assert.equal(seen.p79.ids.length, 200);
  assert.equal(seen.p0, undefined);
});
