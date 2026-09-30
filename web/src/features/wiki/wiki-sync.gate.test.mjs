/**
 * The live co-edit team-scope gate.
 *
 * Receivers used to apply live updates (kind:20003) from ANY author, so a
 * non-editor could edit a team-scoped page over the transport even though the
 * editor UI blocked them. The decision is the pure `liveUpdatePermitted` seam
 * in `lib/knowledge.ts` (production — `wiki-sync.ts`'s `onInbound` calls it);
 * the transport wiring is source-bound here because the React hook renders
 * behind no DOM harness under `node --test` (the established pattern — see
 * `features/identity/ui/ProfileMenu.recoveryExport.test.mjs`).
 *
 * What must keep flowing: editors' updates, own updates, and a read-only
 * viewer's sync traffic (their announcement still runs the handshake so they
 * converge; only their content is discarded).
 *
 * Mutation check: accept-all (make `liveUpdatePermitted` return true, or
 * replace the `permitted` binding with `true`) fails these tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { liveUpdatePermitted } from "./lib/knowledge.ts";

const EDITOR = "a".repeat(64); // team seat holder
const VIEWER = "b".repeat(64); // community member, not a seat holder
const ME = "c".repeat(64); // this browser

const seats = (teamId) => (teamId === "team-design" ? [EDITOR] : null);
const scoped = { scope: "team-design" };

test("a non-editor's live update is dropped", () => {
  assert.equal(
    liveUpdatePermitted({
      authorPubkey: VIEWER,
      selfPubkey: ME,
      page: scoped,
      resolveTeamSeats: seats,
    }),
    false,
  );
});

test("an editor's live update is applied", () => {
  assert.equal(
    liveUpdatePermitted({
      authorPubkey: EDITOR,
      selfPubkey: ME,
      page: scoped,
      resolveTeamSeats: seats,
    }),
    true,
  );
});

test("own updates keep flowing even for a read-only viewer", () => {
  assert.equal(
    liveUpdatePermitted({
      authorPubkey: VIEWER,
      selfPubkey: VIEWER,
      page: scoped,
      resolveTeamSeats: seats,
    }),
    true,
  );
});

test("an unresolvable scope falls open — the gate never locks everyone out", () => {
  assert.equal(
    liveUpdatePermitted({
      authorPubkey: VIEWER,
      selfPubkey: ME,
      page: { scope: "team-gone" },
      resolveTeamSeats: () => null,
    }),
    true,
  );
});

test("an unscoped page keeps today's open editing", () => {
  assert.equal(
    liveUpdatePermitted({
      authorPubkey: VIEWER,
      selfPubkey: ME,
      page: { scope: null },
      resolveTeamSeats: seats,
    }),
    true,
  );
});

const wikiSync = readFileSync(
  new URL("./wiki-sync.ts", import.meta.url),
  "utf8",
);

test("wiki-sync consults the gate before applying an inbound update", () => {
  assert.match(
    wikiSync,
    /const permitted = liveUpdatePermitted\(\{/,
    "onInbound must ask the page's edit gate about the author",
  );
  // A denied author's bytes reach the sync loop only as the empty probe — the
  // announcement keeps flowing (read-only viewers still converge) while their
  // content can never change the document.
  assert.match(wikiSync, /permitted \? update : SYNC_PROBE/);
  assert.match(
    wikiSync,
    /if \(!permitted\) \{\s*\n\s*rejectedCount \+= 1;/,
    "a dropped update is a debug-visible count, never an error",
  );
  // The gate is read at event time (scopes resolve after mount) from the
  // page's scope + seat resolver, and own updates are identified by the
  // pubkey this browser signs as.
  assert.match(wikiSync, /gateRef\.current\?\.scope/);
  assert.match(wikiSync, /gateRef\.current\?\.resolveTeamSeats/);
  assert.match(wikiSync, /selfPubkey = me;/);
});
