import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "@playwright/test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import {
  goalRecordTemplate,
  projectRecordTemplate,
} from "../../src/features/start/start-record";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { walletOf } from "../anvil/pot-chain";
import { backFor, checkIn, launchProject } from "../e2e/helpers/live-chain";
import {
  NOT_RUNNABLE,
  nameTheLaunch,
  ok,
  publishSigned,
  RUN,
  startMiner,
  waitForRecord,
  worldOnThisChain,
} from "./world";

/**
 * Not a test: `scripts/pot-full-loop.sh --serve` runs this once to leave a project on the local chain and the server for a
 * person to try on a phone. A throwaway founder key (made here, never printed or stored) starts "Lantern" through the same
 * records the app's Start writes, launches it on the chain from anvil's second account, names the launch in the record, and a
 * first backer puts 50 play dollars in so the page has numbers. The link goes to `serve.json` in the run's folder.
 */
test.skip(
  NOT_RUNNABLE !== null || process.env.POT_SERVE !== "1",
  "only run by scripts/pot-full-loop.sh --serve",
);

test("leave a demo project for a person to try", async () => {
  const w = await worldOnThisChain();
  const stopMiner = startMiner();
  const key = generateSecretKey();
  const pub = getPublicKey(key);
  const id = "lantern";
  const now = Math.floor(Date.now() / 1000);
  const draft = {
    name: "Lantern",
    goal: "Solar lamps that ten night-market stalls use.",
    how: "Ten stalls light up with them.",
  };
  const record = projectRecordTemplate(id, draft, now);
  await publishSigned(
    finalizeEvent(
      {
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: "Demo founder" }),
        created_at: now,
      },
      key,
    ),
    key,
  );
  await publishSigned(finalizeEvent(record, key), key);
  const goal = goalRecordTemplate(pub, id, draft);
  await publishSigned(finalizeEvent({ ...goal, created_at: now }, key), key);
  const project = await launchProject(w, id, pub);
  await nameTheLaunch(key, pub, id, project.key);
  await backFor(w, project, w.who.member, 50n);
  await waitForRecord(
    project.key,
    "the first backer's money is in",
    (n) => n.totals.joined === "50000000",
    120,
  );
  ok("a demo project is on the chain and the server shows its numbers");

  // One planned task, so a phone has something to read about the task queue: the team (the throwaway founder) planned its pay
  // on the chain for anvil's account number 5. The notice is long: the chain's clock has to be moved to try the worker's side
  // (see the script's words). The plan names no record here, so the page reads it as "a task".
  await checkIn(w, project);
  await walletOf(w.who.founder).sendCalls(
    [
      pot.announceTaskCall({
        treasury: project.treasury,
        what: `0x${"7a".repeat(32)}`,
        payee: w.who.stranger,
        maxDollars: 2_000_000n,
        shareBps: 449,
      }),
    ],
    31337,
  );
  await waitForRecord(
    project.key,
    "the server read the planned task",
    (n) => n.tasks?.list.some((row) => row.state === "announced") === true,
    120,
  );
  ok("a task is planned on the chain and the server shows it");
  writeFileSync(
    resolve(RUN.stateDir, "serve.json"),
    JSON.stringify({
      link: `/p/${id}-${pub.slice(0, 16)}`,
      key: project.key,
    }),
  );
  stopMiner();
});
