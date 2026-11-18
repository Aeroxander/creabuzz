/**
 * Counting what a page sends the server, for the frame meter (`frame-meter.ts`) and its summary (`frame-report.mjs`).
 * Pure functions, driven by `tests/helpers/frame-count.test.mjs` under `node --test` (not beside
 * this file: the real-server Playwright config would load a `*.test.mjs` here as a spec).
 *
 * The server's general request limit (`crates/buzz-relay/src/rejection.rs`, `enforce_ws_admission`) counts every REQ,
 * COUNT and EVENT a signed-in person sends, over all their sockets, in windows of 5 seconds
 * (`crates/buzz-relay/src/admission.rs`, `WS_BURST_WINDOW_SECS`): the budget is 5 times
 * BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC. Frames sent before the socket signs in are not counted there, so they are not
 * counted here either.
 */

/** The relay's admission window, in milliseconds. */
export const WINDOW_MS = 5_000;

/** The frame types the relay's request limit counts. */
export const COUNTED = new Set(["REQ", "COUNT", "EVENT"]);

/**
 * What a sent frame is: its type (`REQ`, `EVENT`, `AUTH`, ...), and for an AUTH the account signing in. Null for a
 * frame that is not a JSON array starting with a type.
 */
export function sentFrame(payload) {
  let message;
  try {
    message = JSON.parse(String(payload));
  } catch {
    return null;
  }
  if (!Array.isArray(message) || typeof message[0] !== "string") return null;
  const type = message[0];
  const pubkey =
    type === "AUTH" && typeof message[1]?.pubkey === "string"
      ? message[1].pubkey
      : null;
  return { type, pubkey };
}

/** Whether a frame the server sent is a refusal by its general request limit (on OK, CLOSED or NOTICE). */
export function isRequestLimitRefusal(payload) {
  return /rate-limited: (quota exceeded|shared admission unavailable)/.test(
    String(payload),
  );
}

/**
 * The most timestamps (milliseconds, any order) that fall in any one window of `windowMs`: a rolling window, so it is
 * never lower than what the relay's fixed windows see.
 */
export function peakInWindow(times, windowMs = WINDOW_MS) {
  const sorted = [...times].sort((a, b) => a - b);
  let peak = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end] - sorted[start] >= windowMs) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}
