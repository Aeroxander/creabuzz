import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOwnershipGrantTemplate, parseOwnershipGrant } from "./grant.ts";
import {
  buildDeclineTemplate,
  buildJoinRequestTemplate,
  parseJoinRequest,
} from "./join-request.ts";
import { buildPitchTemplate, parsePitch } from "./manifest.ts";
import {
  activeRoleGrants,
  canApprove,
  canonicalRequests,
  deriveBoard,
  deriveProjectState,
} from "./state.ts";

const FOUNDER = "f".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const STRANGER = "7".repeat(64);

const DEFAULT_ROLES = [
  { slug: "founder", label: "The founder", pct: 40 },
  { slug: "writer", label: "The writer", pct: 12 },
  { slug: "designer", label: "The designer", pct: 8 },
];

function makePitch({
  roles = DEFAULT_ROLES,
  founderRole = "founder",
  nodeId = "nebula",
  created_at = 1_000,
  id = "p1",
} = {}) {
  const template = buildPitchTemplate({
    nodeId,
    name: "Nebula",
    summary: "A social app for stargazers.",
    description: "",
    founderRole,
    roles,
  });
  return parsePitch({
    id,
    kind: 37015,
    pubkey: FOUNDER,
    created_at,
    tags: template.tags,
    content: template.content,
  });
}

function makeRequest({
  role = "writer",
  pct = 12,
  requester = ALICE,
  owner = FOUNDER,
  author = requester,
  created_at = 2_000,
  id = "r1",
} = {}) {
  const template = buildJoinRequestTemplate({
    projectId: "nebula",
    owner,
    requester,
    role,
    pct,
    note: "I want this role.",
  });
  return parseJoinRequest({
    id,
    kind: 37016,
    pubkey: author,
    created_at,
    tags: template.tags,
    content: template.content,
  });
}

function makeGrant({
  role = "writer",
  pct = 12,
  grantee = ALICE,
  issuer = FOUNDER,
  created_at = 3_000,
  id = "g1",
} = {}) {
  const template = buildOwnershipGrantTemplate({
    nodeId: "nebula",
    role,
    pct,
    grantee,
    issuer,
  });
  return parseOwnershipGrant({
    id,
    kind: 37011,
    pubkey: issuer,
    created_at,
    tags: template.tags,
    content: template.content,
  });
}

function makeDecline(request, { created_at = 2_500, id = "d1" } = {}) {
  return parseJoinRequest({
    id,
    kind: 37016,
    pubkey: FOUNDER,
    created_at,
    tags: buildDeclineTemplate(request).tags,
    content: buildDeclineTemplate(request).content,
  });
}

function derive({ manifest = makePitch(), requests = [], grants = [] } = {}) {
  return deriveProjectState({ manifest, requests, grants });
}

describe("join request → approval state machine", () => {
  it("starts pending: nothing recorded, everything joinable", () => {
    const state = derive({ requests: [makeRequest()] });
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].status, "pending");
    assert.equal(state.pendingCount, 1);
    assert.equal(state.grantedPct, 0);
    assert.equal(state.remainingPct, 100);
    assert.deepEqual(
      state.roles.filter((r) => r.open).map((r) => r.role.slug),
      ["writer", "designer"],
    );
    assert.ok(canApprove(state, state.requests[0].request).ok);
  });

  it("one approval grant records the stake and closes the request — one write, derived state", () => {
    const request = makeRequest();
    const state = derive({ requests: [request], grants: [makeGrant()] });
    assert.equal(state.requests[0].status, "approved");
    assert.equal(state.requests[0].grant.pct, 12);
    assert.equal(state.pendingCount, 0);
    assert.equal(state.grantedPct, 12);
    assert.equal(state.remainingPct, 88);
    assert.equal(state.roles.find((r) => r.role.slug === "writer").open, false);
    assert.deepEqual(
      state.team.map((m) => [m.pubkey, m.source, m.pct]),
      [
        [FOUNDER, "declared", 40],
        [ALICE, "grant", 12],
      ],
    );
    const check = canApprove(state, request);
    assert.equal(check.ok, false);
  });

  it("a decline is the founder's republication of the same thread", () => {
    const request = makeRequest();
    const state = derive({ requests: [request, makeDecline(request)] });
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].status, "declined");
    assert.equal(state.pendingCount, 0);
    // declining fills nothing
    assert.equal(state.grantedPct, 0);
    assert.equal(state.roles.find((r) => r.role.slug === "writer").open, true);
    const check = canApprove(state, state.requests[0].request);
    assert.deepEqual(check, {
      ok: false,
      reason: "This request was declined.",
    });
  });

  it("a re-request supersedes the founder's decline (newest record wins)", () => {
    const first = makeRequest({ created_at: 2_000, id: "r1" });
    const decline = makeDecline(first, { created_at: 2_500, id: "d1" });
    const again = makeRequest({ created_at: 3_000, id: "r2" });
    const state = derive({ requests: [first, decline, again] });
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].status, "pending");
    assert.equal(state.requests[0].request.eventId, "r2");
  });

  it("collapses older versions of a thread to the newest record", () => {
    const older = makeRequest({ pct: 5, created_at: 2_000, id: "r1" });
    const newer = makeRequest({ pct: 12, created_at: 2_100, id: "r2" });
    const state = derive({ requests: [older, newer] });
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].request.pct, 12);
  });

  it("breaks created_at ties by lowest event id (NIP-ORG review rule)", () => {
    const a = makeRequest({ pct: 5, created_at: 2_000, id: "aaa" });
    const b = makeRequest({ pct: 12, created_at: 2_000, id: "bbb" });
    const canonical = canonicalRequests([b, a]);
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0].eventId, "aaa");
  });

  it("drops a third party's record instead of letting it shadow the thread", () => {
    const original = makeRequest();
    const forged = makeRequest({
      author: STRANGER,
      requester: ALICE,
      pct: 99,
      created_at: 9_000,
      id: "evil",
    });
    const state = derive({ requests: [original, forged] });
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].request.pct, 12);
    assert.equal(state.requests[0].request.eventId, original.eventId);
  });

  it("marks a request whose role was removed from the pitch", () => {
    const request = makeRequest({ role: "editor" });
    const state = derive({ requests: [request] });
    assert.equal(state.requests[0].status, "role-removed");
    assert.equal(state.requests[0].role, null);
    const check = canApprove(state, request);
    assert.deepEqual(check, {
      ok: false,
      reason: "This role is no longer declared in the pitch.",
    });
  });
});

describe("double-grant prevention", () => {
  it("only the project's founder fills a role", () => {
    const strangerGrant = makeGrant({ issuer: STRANGER });
    const state = derive({
      requests: [makeRequest()],
      grants: [strangerGrant],
    });
    assert.equal(activeRoleGrants([strangerGrant], "nebula", FOUNDER).size, 0);
    assert.equal(state.requests[0].status, "pending");
    assert.equal(state.grantedPct, 0);
  });

  it("one active grant per role: a second approval replaces, it never stacks", () => {
    const first = makeGrant({ grantee: ALICE, created_at: 3_000, id: "g1" });
    const second = makeGrant({ grantee: BOB, created_at: 3_100, id: "g2" });
    const state = derive({
      requests: [
        makeRequest({ requester: ALICE }),
        makeRequest({ requester: BOB }),
      ],
      grants: [first, second],
    });
    assert.equal(state.grantedPct, 12, "the same role must not count twice");
    const alice = state.requests.find((r) => r.request.requester === ALICE);
    assert.equal(alice.status, "role-filled");
    const check = canApprove(state, alice.request);
    assert.equal(check.ok, false);
    assert.match(check.reason, /already recorded/);
  });

  it("revoking the grant reopens the role and un-records the approval", () => {
    const active = makeGrant({ created_at: 3_000, id: "g1" });
    const revoked = makeGrant({
      created_at: 3_100,
      id: "g2",
      role: "writer",
    });
    // rewrite the same coordinate with revoked: true (NIP-33 LWW)
    const revokedTemplate = buildOwnershipGrantTemplate({
      nodeId: "nebula",
      role: "writer",
      pct: 12,
      grantee: ALICE,
      issuer: FOUNDER,
    });
    const revokedGrant = parseOwnershipGrant({
      id: revoked.id,
      kind: 37011,
      pubkey: FOUNDER,
      created_at: 3_100,
      tags: revokedTemplate.tags,
      content: JSON.stringify({
        ...JSON.parse(revokedTemplate.content),
        revoked: true,
      }),
    });
    const state = derive({
      requests: [makeRequest()],
      grants: [active, revokedGrant],
    });
    assert.equal(state.grantedPct, 0);
    assert.equal(state.requests[0].status, "pending");
    assert.equal(state.roles.find((r) => r.role.slug === "writer").open, true);
  });
});

describe("the % pool bound", () => {
  it("refuses an approval that would take recorded stakes past 100%", () => {
    // A stale grant (60% recorded while the pitch still declared 60) plus a
    // later pitch edit leaves recorded stakes able to exceed the pool; the
    // guard refuses rather than trusting the sum.
    const stale = makeGrant({ pct: 60, role: "writer", created_at: 3_000 });
    const edited = makePitch({
      roles: [
        { slug: "founder", label: "The founder", pct: 40 },
        { slug: "writer", label: "The writer", pct: 12 },
        { slug: "designer", label: "The designer", pct: 48 },
      ],
      created_at: 4_000,
      id: "p2",
    });
    const request = makeRequest({ role: "designer", pct: 48, requester: BOB });
    const state = derive({
      manifest: edited,
      requests: [request],
      grants: [stale],
    });
    assert.equal(state.grantedPct, 60);
    const check = canApprove(state, request);
    assert.deepEqual(check, {
      ok: false,
      reason:
        "Recording 48% would take recorded stakes to 108% of a 100% pool.",
    });
  });

  it("refuses a request above the role's declared target", () => {
    const request = makeRequest({ pct: 50 });
    const state = derive({ requests: [request] });
    const check = canApprove(state, request);
    assert.equal(check.ok, false);
    assert.match(check.reason, /at most 12%/);
  });

  it("refuses every approval while the pitch itself declares over the pool", () => {
    // The relay bounds each role tag to ≤100 individually, so a pitch that
    // declares 140% across tags can exist; the board must never act on it.
    const manifest = parsePitch({
      id: "p3",
      kind: 37015,
      pubkey: FOUNDER,
      created_at: 1_000,
      tags: [
        ["d", "nebula"],
        ["role", "founder", "The founder", "70"],
        ["role", "writer", "The writer", "70"],
      ],
      content: JSON.stringify({ v: 1, summary: "s", founderRole: "founder" }),
    });
    const request = makeRequest();
    const state = derive({ manifest, requests: [request] });
    assert.equal(state.overPool, true);
    const check = canApprove(state, request);
    assert.equal(check.ok, false);
    assert.match(check.reason, /fix the pitch/);
  });

  it("never opens the founder's own role to an approval", () => {
    const request = makeRequest({ role: "founder" });
    const state = derive({ requests: [request] });
    const check = canApprove(state, request);
    assert.deepEqual(check, {
      ok: false,
      reason: "That is the founder's own role.",
    });
  });

  it("refuses a request that is no longer on the board", () => {
    const state = derive({});
    const request = makeRequest();
    const check = canApprove(state, request);
    assert.equal(check.ok, false);
    assert.match(check.reason, /no longer on this project's board/);
  });
});

describe("deriveBoard", () => {
  const pitch = makePitch();
  const node = {
    pubkey: FOUNDER,
    created_at: 900,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula"],
    ],
  };

  it("renders a card with roles, founder, activity, and org-node presence", () => {
    const board = deriveBoard({
      pitches: [pitch],
      nodes: [node],
      requests: [
        makeRequest(),
        makeRequest({ requester: BOB, role: "designer", id: "r2" }),
      ],
      grants: [makeGrant()],
      me: BOB,
    });
    assert.equal(board.length, 1);
    const card = board[0];
    assert.equal(card.key, `${FOUNDER}:nebula`);
    assert.equal(card.name, "Nebula");
    assert.deepEqual(
      card.openRoles.map((r) => r.slug),
      ["designer"],
    );
    assert.equal(card.filledRoles, 2);
    assert.equal(card.members, 2);
    assert.equal(card.pendingRequests, 1);
    assert.equal(card.myRequestPending, true);
    assert.equal(card.hasNode, true);
    assert.equal(card.updatedAt, 3_000);
  });

  it("flags a pitch whose org node has not synced (approvals need the node)", () => {
    const board = deriveBoard({
      pitches: [pitch],
      nodes: [],
      requests: [],
      grants: [],
    });
    assert.equal(board[0].hasNode, false);
  });

  it("keeps one card per (founder, id) when the pitch is edited", () => {
    const edited = makePitch({ created_at: 5_000, id: "p2" });
    edited.summary = "Rewritten pitch.";
    const board = deriveBoard({
      pitches: [pitch, edited],
      nodes: [node],
      requests: [],
      grants: [],
    });
    assert.equal(board.length, 1);
    assert.equal(board[0].summary, "Rewritten pitch.");
    assert.equal(board[0].updatedAt, 5_000);
  });

  it("ignores a my-request flag when nobody is signed in", () => {
    const board = deriveBoard({
      pitches: [pitch],
      nodes: [node],
      requests: [makeRequest()],
      grants: [],
    });
    assert.equal(board[0].myRequestPending, false);
  });
});
