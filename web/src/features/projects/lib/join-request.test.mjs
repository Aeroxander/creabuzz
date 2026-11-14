import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JoinRequestValidationError,
  buildDeclineTemplate,
  buildJoinRequestTemplate,
  joinRequestKey,
  parseJoinRequest,
} from "./join-request.ts";

const FOUNDER = "f".repeat(64);
const REQUESTER =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const OTHER = "b".repeat(64);

const INPUT = {
  projectId: "nebula",
  owner: FOUNDER,
  requester: REQUESTER,
  role: "writer",
  pct: 12,
  note: "I write the launch story.",
};

function sign(template, overrides = {}) {
  return {
    id: overrides.id ?? "c".repeat(64),
    kind: template.kind,
    pubkey: overrides.pubkey ?? REQUESTER,
    created_at: overrides.created_at ?? 2_000,
    tags: template.tags,
    content: template.content,
  };
}

describe("buildJoinRequestTemplate", () => {
  it("composes the golden kind:37016 tags and content body", () => {
    const template = buildJoinRequestTemplate(INPUT);
    assert.equal(template.kind, 37016);
    assert.deepEqual(template.tags, [
      ["d", "nebula/writer/abcdef0123456789"],
      ["role", "writer"],
      ["p", FOUNDER],
    ]);
    assert.deepEqual(JSON.parse(template.content), {
      v: 1,
      project: "nebula",
      owner: FOUNDER,
      role: "writer",
      pct: "12",
      note: "I write the launch story.",
      requester: REQUESTER,
    });
  });

  it("keeps every coordinate inside the relay's 64-char d bound", () => {
    assert.equal(
      joinRequestKey("n".repeat(32), "r".repeat(12), "a".repeat(64)).length,
      62,
    );
    const template = buildJoinRequestTemplate({
      ...INPUT,
      projectId: "n".repeat(32),
      role: "r".repeat(12),
    });
    const d = template.tags[0][1];
    assert.ok(d.length <= 64, `d was ${d.length} chars`);
    assert.equal(d, joinRequestKey("n".repeat(32), "r".repeat(12), REQUESTER));
  });

  it("refuses a request the relay would reject", () => {
    for (const bad of [
      { projectId: "has space" },
      { role: "Writer!" },
      { pct: 0 },
      { pct: 101 },
      { pct: 12.5 },
      { note: "" },
      { owner: "nope" },
      { requester: "nope" },
    ]) {
      assert.throws(
        () => buildJoinRequestTemplate({ ...INPUT, ...bad }),
        (error) => error instanceof JoinRequestValidationError,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });
});

describe("buildDeclineTemplate", () => {
  it("republishes the same thread under the founder's key, carrying the requester forward", () => {
    const request = parseJoinRequest(sign(buildJoinRequestTemplate(INPUT)));
    assert.ok(request);
    const decline = buildDeclineTemplate(request);
    assert.equal(decline.kind, 37016);
    assert.deepEqual(decline.tags, [
      ["d", "nebula/writer/abcdef0123456789"],
      ["role", "writer"],
      ["p", FOUNDER],
    ]);
    const body = JSON.parse(decline.content);
    assert.equal(body.decision, "declined");
    assert.equal(body.requester, REQUESTER);
    assert.equal(body.owner, FOUNDER);
    assert.equal(body.pct, "12");
  });
});

describe("parseJoinRequest", () => {
  it("round-trips what the builder composed", () => {
    const request = parseJoinRequest(sign(buildJoinRequestTemplate(INPUT)));
    assert.ok(request);
    assert.equal(request.projectId, "nebula");
    assert.equal(request.owner, FOUNDER);
    assert.equal(request.requester, REQUESTER);
    assert.equal(request.role, "writer");
    assert.equal(request.pct, 12);
    assert.equal(request.decision, null);
    assert.equal(request.author, REQUESTER);
  });

  it("reads a founder's decline and keeps the requester identity", () => {
    const original = parseJoinRequest(sign(buildJoinRequestTemplate(INPUT)));
    const decline = sign(buildDeclineTemplate(original), {
      pubkey: FOUNDER,
      created_at: 3_000,
      id: "d".repeat(64),
    });
    const request = parseJoinRequest(decline);
    assert.ok(request);
    assert.equal(request.decision, "declined");
    assert.equal(request.requester, REQUESTER);
    assert.equal(request.author, FOUNDER);
  });

  it("falls back to the p tag when owner is absent, and to the author when requester is absent", () => {
    const template = buildJoinRequestTemplate(INPUT);
    const body = JSON.parse(template.content);
    delete body.owner;
    delete body.requester;
    const request = parseJoinRequest(
      sign({ ...template, content: JSON.stringify(body) }),
    );
    assert.ok(request);
    assert.equal(request.owner, FOUNDER);
    assert.equal(request.requester, REQUESTER);
  });

  it("drops an unattributable record instead of showing it on a stranger's board", () => {
    const template = buildJoinRequestTemplate(INPUT);
    const body = JSON.parse(template.content);
    delete body.owner;
    const orphan = { ...template, content: JSON.stringify(body) };
    assert.equal(
      parseJoinRequest(
        sign({ ...orphan, tags: orphan.tags.filter((t) => t[0] !== "p") }),
      ),
      null,
    );
  });

  it("drops records with no coordinate, no role, or an unbounded percentage", () => {
    const template = buildJoinRequestTemplate(INPUT);
    const body = JSON.parse(template.content);
    const cases = [
      {
        desc: "no d tag",
        tags: template.tags.filter((t) => t[0] !== "d"),
        content: template.content,
      },
      {
        desc: "bad role",
        tags: template.tags,
        content: JSON.stringify({ ...body, role: "Writer!" }),
      },
      {
        desc: "pct above pool",
        tags: template.tags,
        content: JSON.stringify({ ...body, pct: "101" }),
      },
      {
        desc: "pct not a number",
        tags: template.tags,
        content: JSON.stringify({ ...body, pct: "12%" }),
      },
      { desc: "junk content", tags: template.tags, content: "not json" },
      {
        desc: "wrong kind",
        tags: template.tags,
        content: template.content,
        kind: 37015,
      },
    ];
    for (const { desc, tags, content, kind } of cases) {
      const request = parseJoinRequest(
        sign({ kind: kind ?? 37016, tags, content }),
      );
      assert.equal(request, null, `${desc} must be dropped`);
    }
  });

  it("treats an unknown decision as no decision (fail open to the request)", () => {
    const template = buildJoinRequestTemplate(INPUT);
    const body = JSON.parse(template.content);
    const request = parseJoinRequest(
      sign({
        ...template,
        content: JSON.stringify({ ...body, decision: "deferred" }),
        pubkey: FOUNDER,
      }),
    );
    assert.ok(request);
    assert.equal(request.decision, null);
  });

  it("gives two requesters of the same role different threads", () => {
    const mine = joinRequestKey("nebula", "writer", REQUESTER);
    const theirs = joinRequestKey("nebula", "writer", OTHER);
    assert.notEqual(mine, theirs);
    assert.equal(mine, "nebula/writer/abcdef0123456789");
    assert.equal(theirs, "nebula/writer/bbbbbbbbbbbbbbbb");
  });
});
