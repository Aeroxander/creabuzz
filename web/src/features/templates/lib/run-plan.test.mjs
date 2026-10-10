/**
 * Running a template against a fake server: the whole plan in order, a refusal
 * that stops it, and applying again that writes only what is left, with the
 * server's own records as the only memory (nothing local survives between the
 * two runs).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { TEMPLATE_CATALOG } from "@creaton/core/templates/catalog.generated.ts";
import {
  planApply,
  emptyExisting,
  markerItem,
} from "@creaton/core/templates/apply.ts";

import { buildExistingState } from "./existing-state.ts";
import { explainStepFailure } from "./explain.ts";
import { runPlan } from "./run-plan.ts";

const ME = "a".repeat(64);

/** A server that keeps what it is sent, and can be told to refuse the Nth write. */
function fakeServer({ refuseAt = null } = {}) {
  const accepted = [];
  let writes = 0;
  return {
    accepted,
    publish: async (draft) => {
      writes += 1;
      if (refuseAt !== null && writes === refuseAt) {
        throw new Error("restricted: only the owner may do this");
      }
      accepted.push({
        id: `event-${accepted.length + 1}`,
        kind: draft.kind,
        created_at: draft.created_at,
        tags: draft.tags,
      });
    },
  };
}

/** What the server would send back: channel metadata, the marked records, the org. */
function readBack(server, templateId) {
  const channelRecords = server.accepted
    .filter((r) => r.kind === 9007)
    .map((r) => ({
      id: r.id,
      kind: 39000,
      created_at: r.created_at,
      tags: [
        ["d", r.tags.find((t) => t[0] === "h")[1]],
        ["name", r.tags.find((t) => t[0] === "name")[1]],
      ],
    }));
  return buildExistingState({
    templateId,
    channelRecords,
    markerRecords: server.accepted.filter(
      (r) => markerItem(r.tags, templateId) !== null,
    ),
    orgRecords: server.accepted.filter(
      (r) => r.kind === 37010 || r.kind === 37012,
    ),
  });
}

function options(entry, existing, server, extra = {}) {
  let n = 0;
  return {
    entry,
    plan: planApply(entry, existing),
    existing,
    me: ME,
    publish: server.publish,
    explain: explainStepFailure,
    now: () => 1000,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    ...extra,
  };
}

test("a whole template is applied from nothing, in plan order", async () => {
  const entry = TEMPLATE_CATALOG["ai-media-studio"];
  const server = fakeServer();
  const report = await runPlan(options(entry, emptyExisting(), server));
  assert.equal(report.status, "done");
  assert.ok(
    report.results.every((r) => r.status === "created"),
    JSON.stringify(report.results.filter((r) => r.status !== "created")),
  );
  // The first thing written is a channel, the last is the welcome message.
  assert.equal(server.accepted[0].kind, 9007);
  assert.equal(server.accepted.at(-1).kind, 9);
  assert.equal(server.accepted.length, report.results.length);
  // Every channel the template names now has an id the later steps used.
  for (const channel of entry.template.channels) {
    assert.match(report.channelIds[channel.id], /^[0-9a-f-]{36}$/);
  }
  // The organization is there: the founder seat, a seat per helper, the budget.
  const orgNodes = server.accepted.filter((r) => r.kind === 37010);
  assert.equal(orgNodes.length, 1 + entry.template.org.seats.length);
  assert.equal(server.accepted.filter((r) => r.kind === 37012).length, 1);
});

test("a refusal stops the run, keeps what went through, and applying again writes only the rest", async () => {
  const entry = TEMPLATE_CATALOG["ai-media-studio"];
  const server = fakeServer({ refuseAt: 12 });
  const first = await runPlan(options(entry, emptyExisting(), server));

  assert.equal(first.status, "partial");
  const failedAt = first.results.findIndex((r) => r.status === "failed");
  assert.equal(failedAt, 11);
  assert.match(
    first.results[failedAt].message,
    /Only this community's owner or an admin|can't create channels|permission/,
  );
  assert.match(
    first.results[failedAt].message,
    /Whatever already went through is kept/,
  );
  // Everything before is created, everything after was never tried.
  assert.ok(
    first.results.slice(0, failedAt).every((r) => r.status === "created"),
  );
  assert.ok(
    first.results
      .slice(failedAt + 1)
      .every((r) => r.status === "not-attempted"),
  );
  assert.equal(server.accepted.length, failedAt);

  // The server's records are the only memory: read them back and apply again.
  const existing = readBack(server, entry.template.id);
  const second = await runPlan(
    options(entry, existing, server, {
      newId: (() => {
        let n = 100;
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      })(),
    }),
  );
  assert.equal(second.status, "done");
  const created = second.results.filter((r) => r.status === "created").length;
  const skipped = second.results.filter((r) => r.status === "skipped").length;
  assert.equal(
    skipped,
    failedAt,
    "everything that went through the first time is skipped",
  );
  assert.equal(created + skipped, second.results.length);
  // Together the two runs wrote the plan exactly once.
  assert.equal(server.accepted.length, second.results.length);

  // A third run has nothing left to do.
  const third = await runPlan(
    options(entry, readBack(server, entry.template.id), server),
  );
  assert.equal(third.results.filter((r) => r.status === "created").length, 0);
  assert.equal(server.accepted.length, second.results.length);
});

test("a skill that needs the command line is reported, not failed", async () => {
  const entry = TEMPLATE_CATALOG["crypto-app-studio"];
  const server = fakeServer();
  const report = await runPlan(options(entry, emptyExisting(), server));
  assert.equal(report.status, "done");
  const needing = report.results.filter((r) => r.status === "needs-cli");
  assert.deepEqual(
    needing.map((r) => r.step.kind),
    ["skill"],
  );
  assert.equal(server.accepted.length, report.results.length - 1);
});

test("progress is reported after every step", async () => {
  const entry = TEMPLATE_CATALOG["vanilla-app-studio"];
  const seen = [];
  const report = await runPlan(
    options(entry, emptyExisting(), fakeServer(), {
      onProgress: (results) =>
        seen.push(results.filter((r) => r.status === "created").length),
    }),
  );
  assert.equal(seen.length, report.results.length);
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => a - b),
  );
  assert.equal(seen.at(-1), report.results.length);
});

test("a step that cannot be built fails with a message instead of throwing", async () => {
  const entry = structuredClone(TEMPLATE_CATALOG["vanilla-app-studio"]);
  delete entry.files[entry.template.welcome];
  const report = await runPlan(options(entry, emptyExisting(), fakeServer()));
  assert.equal(report.status, "partial");
  const failed = report.results.find((r) => r.status === "failed");
  assert.equal(failed.step.kind, "welcome");
});
