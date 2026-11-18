import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contributorKitNamed,
  moneyOffered,
  sharesSetupOffered,
} from "./money-offered.ts";

const KIT = `{"31337":"0x${"b2".repeat(20)}"}`;
const FACTORY = `{"31337":"0x${"fa".repeat(20)}"}`;

/** The hosted pilot: no sales, investing off, no kit. */
const PILOT = { VITE_CONTRIBUTOR_ONLY: "1" };

test("a build with no sales, investing off and no contributor kit has no money on it", () => {
  assert.equal(moneyOffered(PILOT), false);
  // An empty or broken kit setting names nothing.
  assert.equal(moneyOffered({ ...PILOT, VITE_CONTRIBUTOR_KITS: "" }), false);
  assert.equal(moneyOffered({ ...PILOT, VITE_CONTRIBUTOR_KITS: "{}" }), false);
  // The switch alone, with no pool factory, is not investing.
  assert.equal(moneyOffered({ ...PILOT, VITE_INVESTING: "1" }), false);
});

test("any one of sales, investing or a contributor kit brings the money cards back", () => {
  assert.equal(moneyOffered({}), true);
  assert.equal(moneyOffered(undefined), true);
  assert.equal(moneyOffered({ ...PILOT, VITE_CONTRIBUTOR_KITS: KIT }), true);
  assert.equal(
    moneyOffered({
      ...PILOT,
      VITE_INVESTING: "1",
      VITE_BACKING_POOL_FACTORY: FACTORY,
    }),
    true,
  );
});

test("a contributor kit is named by the plain kit, or by the pooled one only where investing is on", () => {
  assert.equal(contributorKitNamed({}), false);
  assert.equal(contributorKitNamed({ VITE_CONTRIBUTOR_KITS: KIT }), true);
  assert.equal(contributorKitNamed({ VITE_CONTRIBUTOR_KIT_V3: KIT }), false);
  assert.equal(
    contributorKitNamed({
      VITE_CONTRIBUTOR_KIT_V3: KIT,
      VITE_INVESTING: "1",
      VITE_BACKING_POOL_FACTORY: FACTORY,
    }),
    true,
  );
});

test("Shares are offered from the first piece of accepted work, never on a project's first day, never without a kit", () => {
  assert.equal(sharesSetupOffered({ kitNamed: true, acceptedWork: 0 }), false);
  // Still reading the tasks: nothing is offered on a guess.
  assert.equal(
    sharesSetupOffered({ kitNamed: true, acceptedWork: null }),
    false,
  );
  assert.equal(sharesSetupOffered({ kitNamed: true, acceptedWork: 1 }), true);
  assert.equal(sharesSetupOffered({ kitNamed: true, acceptedWork: 4 }), true);
  assert.equal(sharesSetupOffered({ kitNamed: false, acceptedWork: 4 }), false);
});

test("work a founder did alone and checked themself never unlocks Shares; work someone else accepted does", async () => {
  const { parseTaskRecord, projectTasks, taskEvent, taskStepEvent } =
    await import("./tasks.ts");
  const { sharesAcceptedWork } = await import("./money-offered.ts");
  const FOUNDER = "f".repeat(64);
  const MATE = "c".repeat(64);
  const COORD = `37001:${FOUNDER}:demo`;
  let n = 0;
  const signed = (pubkey, built) => {
    n += 1;
    return {
      id: n.toString(16).padStart(64, "0"),
      pubkey,
      created_at: 1_794_000_000,
      kind: 47003,
      tags: [["a", COORD], ...built.tags],
      content: JSON.stringify(built.content),
      sig: "sig",
    };
  };
  const step = (who, task, part, over = {}) =>
    signed(who, taskStepEvent({ part, taskId: task.id, tell: [], ...over }));
  const task = signed(
    FOUNDER,
    taskEvent({
      helper: FOUNDER,
      what: "Write the changelog.",
      done: "A changelog page is live.",
      size: "small",
    }),
  );
  const work = step(FOUNDER, task, "evidence", { note: "It is live." });
  const own = step(FOUNDER, task, "confirm", { evidenceId: work.id });
  const read = (events, team) =>
    projectTasks({
      records: events.flatMap((e) => parseTaskRecord(e) ?? []),
      coordinate: COORD,
      team: new Set(team),
      now: 1_794_312_000,
    });
  // Done, by the founder's own check: a finished task, and still not one that counts toward Shares.
  const alone = read([task, work, own], [FOUNDER]);
  assert.equal(alone[0].state, "confirmed");
  assert.equal(sharesAcceptedWork(alone), 0);
  assert.equal(
    sharesSetupOffered({
      kitNamed: true,
      acceptedWork: sharesAcceptedWork(alone),
    }),
    false,
  );
  // However many of them there are.
  assert.equal(sharesAcceptedWork([...alone, ...alone, ...alone]), 0);
  // The same work, accepted by someone else on the team: now it counts.
  const accepted = read(
    [task, work, own, step(MATE, task, "confirm", { evidenceId: work.id })],
    [FOUNDER, MATE],
  );
  assert.equal(sharesAcceptedWork(accepted), 1);
  assert.equal(
    sharesSetupOffered({
      kitNamed: true,
      acceptedWork: sharesAcceptedWork(accepted),
    }),
    true,
  );
});
