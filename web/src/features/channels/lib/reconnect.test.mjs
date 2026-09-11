import assert from "node:assert/strict";
import test from "node:test";

import { ReconnectBackoff, reconnectDelay } from "./reconnect.ts";

const noJitter = () => 0;

test("backoff doubles from a second and stops at the ceiling", () => {
  assert.equal(reconnectDelay(1, noJitter), 1_000);
  assert.equal(reconnectDelay(2, noJitter), 2_000);
  assert.equal(reconnectDelay(3, noJitter), 4_000);
  assert.equal(reconnectDelay(4, noJitter), 8_000);
  assert.equal(reconnectDelay(5, noJitter), 16_000);
  // Capped: a relay that stays down must not retry every second forever.
  assert.equal(reconnectDelay(6, noJitter), 30_000);
  assert.equal(reconnectDelay(50, noJitter), 30_000);
});

test("jitter spreads retries but stays within its share", () => {
  assert.equal(
    reconnectDelay(1, () => 1),
    1_300,
  );
  assert.equal(
    reconnectDelay(2, () => 1),
    2_600,
  );
  assert.equal(
    reconnectDelay(6, () => 1),
    39_000,
  );
  for (const attempt of [1, 2, 3, 7, 20]) {
    const delay = reconnectDelay(attempt, () => 0.5);
    const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
    assert.ok(delay >= base, `${attempt}: ${delay} below base ${base}`);
    assert.ok(delay <= base * 1.3, `${attempt}: ${delay} above jittered cap`);
  }
});

test("a nonsense attempt still yields a usable delay", () => {
  assert.equal(reconnectDelay(0, noJitter), 1_000);
  assert.equal(reconnectDelay(-3, noJitter), 1_000);
});

test("reconnect backoff only resets when the connection proved usable", () => {
  const backoff = new ReconnectBackoff(noJitter);
  // A relay that accepts and immediately closes: the delay must grow instead of
  // settling at the first step, or the tab re-opens once a second forever.
  const delays = [1, 2, 3, 4, 5, 6].map(() => {
    backoff.onOpen();
    return backoff.onClose();
  });
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  assert.equal(backoff.attempt, 6);
});

test("a working subscription resets the backoff", () => {
  const backoff = new ReconnectBackoff(noJitter);
  for (let index = 0; index < 5; index += 1) {
    backoff.onOpen();
    backoff.onClose();
  }
  assert.equal(backoff.attempt, 5);

  backoff.onOpen();
  backoff.onHealthy(); // the relay answered the subscription
  backoff.onClose();
  assert.equal(backoff.attempt, 1, "back to the first step after a good run");
  assert.equal(backoff.onClose(), 2_000);
});
