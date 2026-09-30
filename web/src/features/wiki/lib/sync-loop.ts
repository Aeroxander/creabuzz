/**
 * Peer-sync loop control for the live wiki room.
 *
 * Peers echo their full document state after receiving an update so a late
 * joiner converges. That echo has to be conditioned on the update having
 * actually advanced our document: once two peers agree, both of them keep
 * receiving the other's state, and an unconditional echo makes them answer
 * each other one message per throttle window for as long as the room lives.
 */

import * as Y from "yjs";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Apply a peer's update and report whether it advanced this document.
 *
 * A state vector only grows when the document learns something new, so an
 * update we already had (the common case once peers are converged) returns
 * `false`. Callers use that to stop echoing.
 */
export function applyPeerUpdate(doc: Y.Doc, bytes: Uint8Array): boolean {
  const before = Y.encodeStateVector(doc);
  Y.applyUpdate(doc, bytes, "remote");
  return !sameBytes(before, Y.encodeStateVector(doc));
}
