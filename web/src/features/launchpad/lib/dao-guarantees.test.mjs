import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NOTICE,
  noticeText,
  readDaoGuarantees,
} from "./dao-guarantees.ts";

const DAO = `0x${"d0".repeat(20)}`;
const POLICY = `0x${"90".repeat(20)}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const HOUR = 3600;
const DAY = 24 * HOUR;

/** `lanes(i)`: quorum, approval, review, hold, exclusive. */
const lane = (review, hold) =>
  `0x${[2000, 6600, review, hold, 1].map((n) => word(n).slice(2)).join("")}`;

function chain(answers) {
  return async (to, data) => {
    const answer = answers[`${to.toLowerCase()} ${data}`];
    if (answer === undefined) throw new Error("execution reverted");
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const kitDao = (over = {}) => ({
  [`${DAO} 0xaf56f7dc`]: word(0), // leaving(): made after D73
  [`${DAO} 0x14a6d7de`]: word(1), // ragequittable()
  [`${DAO} 0xeef09bad`]: word(DAY), // timelockDelay()
  [`${POLICY} 0x713c311a${word(0).slice(2)}`]: lane(48 * HOUR, 12 * HOUR),
  [`${POLICY} 0x713c311a${word(1).slice(2)}`]: lane(24 * HOUR, 6 * HOUR),
  ...over,
});

test("a kit's DAO: leaving is permanent, and today's notice is three days and two", async () => {
  const g = await readDaoGuarantees(chain(kitDao()), DAO, POLICY);
  assert.equal(g.leavingPermanent, true);
  assert.equal(g.ragequittable, true);
  assert.equal(g.notice.full, 3 * DAY);
  assert.equal(g.notice.bounded, 2 * DAY);
});

test("a DAO made before leaving became permanent says so", async () => {
  const answers = kitDao();
  delete answers[`${DAO} 0xaf56f7dc`];
  const g = await readDaoGuarantees(chain(answers), DAO, POLICY);
  assert.equal(g.leavingPermanent, false);
});

test("a shortened setting is what the card says, not the starting default", async () => {
  const g = await readDaoGuarantees(
    chain(
      kitDao({
        [`${DAO} 0xeef09bad`]: word(1),
        [`${POLICY} 0x713c311a${word(0).slice(2)}`]: lane(DAY, 0),
      }),
    ),
    DAO,
    POLICY,
  );
  assert.equal(g.notice.full, DAY + 1);
});

test("a network failure is an error, never a guarantee", async () => {
  await assert.rejects(
    readDaoGuarantees(
      chain(kitDao({ [`${DAO} 0xaf56f7dc`]: new Error("rpc http 503") })),
      DAO,
      POLICY,
    ),
  );
});

test("the notice is said as today's setting that a vote can shorten, never as a permanent floor", () => {
  const today = noticeText({ full: 3 * DAY, bounded: 2 * DAY }, "dao");
  assert.match(today, /With this DAO's settings today, every decision waits/);
  assert.match(today, /at least 3 days for anything that spends the treasury/);
  assert.match(today, /2 days for an award or a project/);
  assert.match(today, /a vote can shorten them for decisions opened later/);
  assert.match(today, /as little as a day/);
  const planned = noticeText(DEFAULT_NOTICE, "plan");
  assert.match(
    planned,
    /starts out with every decision waiting at least 3 days/,
  );
  assert.match(planned, /a vote can shorten them for decisions opened later/);
  const shortened = noticeText({ full: DAY + 1, bounded: DAY + 1 }, "dao");
  assert.match(shortened, /at least 24 hours for anything/);
});
