import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_REFRESH_DELAY_MS,
  nextMoment,
  refreshDelay,
} from "./work-refresh.ts";

const claim = (status, expiresAt, releasedAt = 0) => ({
  record: { status, expiresAt, releasedAt },
});

test("the page reads again just after the soonest moment a claim's step changes by itself", () => {
  const work = {
    chainTime: 1_000,
    mandates: [
      {
        challengeWindow: 100,
        claims: [
          claim("Open", 5_000),
          claim("Approved", 0, 950), // its window ends at 1,050
          claim("Approved", 0, 800), // already past
          claim("Paid", 0, 900),
          claim("Open", 0),
        ],
      },
    ],
  };
  assert.equal(nextMoment(work), 1_050);
  // An open claim lapses one second after its deadline.
  assert.equal(
    nextMoment({
      chainTime: 1_000,
      mandates: [{ challengeWindow: 1, claims: [claim("Open", 2_000)] }],
    }),
    2_001,
  );
  assert.equal(nextMoment({ chainTime: 1_000, mandates: [] }), null);
  assert.equal(refreshDelay(1_050, 1_000), 53_000);
  assert.equal(refreshDelay(1_000, 1_000), 3_000);
  assert.equal(refreshDelay(1_000 + MAX_REFRESH_DELAY_MS / 1000, 1_000), null);
});
