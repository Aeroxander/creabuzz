import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  COUNTED,
  WINDOW_MS,
  isRequestLimitRefusal,
  peakInWindow,
  sentFrame,
} from "../e2e-real/frame-count.mjs";

const relay = (path) =>
  readFileSync(
    new URL(`../../../crates/buzz-relay/src/${path}`, import.meta.url),
    "utf8",
  );

describe("peakInWindow", () => {
  it("counts the busiest rolling window, not a fixed one", () => {
    // Two fixed windows of 3 each, but 4 inside one rolling 5 seconds.
    assert.equal(peakInWindow([1000, 3000, 4500, 5500, 6000, 9000]), 4);
  });

  it("treats the window as half-open, like a 5-second bucket", () => {
    assert.equal(peakInWindow([0, 4999]), 2);
    assert.equal(peakInWindow([0, 5000]), 1);
  });

  it("takes timestamps in any order, and none at all", () => {
    assert.equal(peakInWindow([9000, 0, 1, 2]), 3);
    assert.equal(peakInWindow([]), 0);
  });
});

describe("sentFrame", () => {
  it("names the type, and the account an AUTH signs in", () => {
    assert.deepEqual(sentFrame('["REQ","s1",{"kinds":[1]}]'), {
      type: "REQ",
      pubkey: null,
    });
    assert.deepEqual(
      sentFrame(JSON.stringify(["AUTH", { pubkey: "ab".repeat(32) }])),
      { type: "AUTH", pubkey: "ab".repeat(32) },
    );
    assert.equal(sentFrame("not json"), null);
    assert.equal(sentFrame('{"REQ":1}'), null);
  });
});

describe("the relay's request limit", () => {
  it("is what the meter counts", () => {
    // If the relay counts other frames, or a different window, the meter's numbers stop meaning the limit.
    const rejection = relay("rejection.rs");
    assert.match(
      rejection,
      /matches!\(msg, ClientMessage::Req \{ \.\. \} \| ClientMessage::Count \{ \.\. \}\)/,
    );
    assert.match(rejection, /ClientMessage::Event\(_\)/);
    assert.deepEqual([...COUNTED].sort(), ["COUNT", "EVENT", "REQ"]);
    assert.match(
      relay("admission.rs"),
      new RegExp(`WS_BURST_WINDOW_SECS: u64 = ${WINDOW_MS / 1000};`),
    );
  });

  it("refusals are recognised in the relay's wording", () => {
    assert.equal(
      isRequestLimitRefusal(
        '["CLOSED","s1","rate-limited: quota exceeded; retry in 3s"]',
      ),
      true,
    );
    assert.equal(
      isRequestLimitRefusal(
        '["OK","ab",false,"rate-limited: shared admission unavailable"]',
      ),
      true,
    );
    assert.equal(
      isRequestLimitRefusal(
        '["OK","ab",false,"rate-limited: you can start 5 boards a day; try again tomorrow"]',
      ),
      false,
    );
  });
});
