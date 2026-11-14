import assert from "node:assert/strict";
import test from "node:test";

import {
  ipDraftFromRecord,
  ipDraftProblem,
  ipRecordFromDraft,
  ipRecordContent,
  ipStanding,
  ipSummary,
  parseIpDocument,
  parseIpRecord,
  secureUrl,
} from "./ip-record.ts";

const SHA = "ab".repeat(32);
const doc = (title = "Assignment") => ({
  title,
  url: "https://example.com/assignment.pdf",
  sha256: SHA,
});
const entity = {
  name: "Nebula Series LLC",
  jurisdiction: "Marshall Islands",
  registration: null,
};

test("a document needs a title, an https link and a 64-character fingerprint", () => {
  assert.deepEqual(parseIpDocument(doc()), {
    title: "Assignment",
    url: "https://example.com/assignment.pdf",
    sha256: SHA,
  });
  assert.equal(
    parseIpDocument({ ...doc(), sha256: SHA.toUpperCase() }).sha256,
    SHA,
  );
  for (const bad of [
    null,
    "x",
    [],
    { ...doc(), title: "  " },
    { ...doc(), url: "http://example.com/a.pdf" },
    { ...doc(), url: "javascript:alert(1)" },
    { ...doc(), url: "file:///etc/passwd" },
    { ...doc(), url: "not a url" },
    { ...doc(), sha256: "abc" },
    { ...doc(), sha256: "z".repeat(64) },
  ]) {
    assert.equal(parseIpDocument(bad), null, JSON.stringify(bad));
  }
});

test("secureUrl refuses everything but https", () => {
  assert.equal(secureUrl("https://a.example/x"), "https://a.example/x");
  assert.equal(secureUrl("http://a.example/x"), null);
  assert.equal(secureUrl("ipfs://bafy"), null);
  assert.equal(secureUrl(5), null);
  // A link is a pointer, not a payload.
  assert.equal(secureUrl(`https://a.example/${"x".repeat(600)}`), null);
});

test("a record names one of three holders, or is refused", () => {
  assert.equal(parseIpRecord(null), null);
  assert.equal(parseIpRecord({ holder: "dao" }), null);
  assert.equal(parseIpRecord("open"), null);
  assert.equal(
    parseIpRecord({ holder: "open", licence: "MIT" }).holder,
    "open",
  );
  assert.equal(parseIpRecord({ holder: "founders" }).holder, "founders");
});

test("what does not belong to a holder is dropped on read", () => {
  const read = parseIpRecord({
    holder: "founders",
    licence: "MIT",
    entity,
    operating: doc("Operating agreement"),
    assignment: doc("Commitment"),
  });
  assert.equal(read.licence, null);
  assert.equal(read.entity, null);
  assert.equal(read.operating, null);
  assert.equal(read.assignment.title, "Commitment");
});

test("a malformed document is dropped, which can only lower the standing", () => {
  const read = parseIpRecord({
    holder: "entity",
    entity,
    assignment: { ...doc(), sha256: "short" },
  });
  assert.equal(read.assignment, null);
  assert.equal(ipStanding(read, true), "entity-unassigned");
});

test("the standing is only as strong as the documents on record", () => {
  const rec = (over) => ({
    v: 1,
    holder: "entity",
    licence: null,
    entity,
    assignment: doc(),
    operating: null,
    contributorTerms: null,
    ...over,
  });
  assert.equal(ipStanding(null, true), "unstated");
  assert.equal(
    ipStanding(rec({ holder: "open", entity: null, assignment: null }), true),
    "unstated",
  );
  assert.equal(
    ipStanding(
      rec({ holder: "open", licence: "MIT", entity: null, assignment: null }),
      false,
    ),
    "open",
  );
  assert.equal(
    ipStanding(
      rec({ holder: "founders", entity: null, assignment: null }),
      true,
    ),
    "founders-uncommitted",
  );
  assert.equal(
    ipStanding(rec({ holder: "founders", entity: null }), true),
    "founders-committed",
  );
  assert.equal(
    ipStanding(rec({ assignment: null }), true),
    "entity-unassigned",
  );
  assert.equal(ipStanding(rec({ entity: null }), true), "entity-unassigned");
  // The assignment takes effect on the raise: not assigned until then.
  assert.equal(ipStanding(rec({}), false), "entity-on-raise");
  assert.equal(ipStanding(rec({}), true), "entity-assigned");
});

test("holders are only said to direct the entity when its operating agreement is on record", () => {
  const base = {
    v: 1,
    holder: "entity",
    licence: null,
    entity,
    assignment: doc(),
    operating: null,
    contributorTerms: null,
  };
  assert.equal(ipSummary("entity-assigned", base).holdersDirect, false);
  assert.equal(
    ipSummary("entity-assigned", {
      ...base,
      operating: doc("Operating agreement"),
    }).holdersDirect,
    true,
  );
  for (const standing of [
    "unstated",
    "open",
    "founders-uncommitted",
    "founders-committed",
    "entity-unassigned",
    "entity-on-raise",
  ]) {
    assert.equal(ipSummary(standing, base).holdersDirect, false, standing);
  }
});

test("no weaker standing says holders own anything", () => {
  const base = {
    v: 1,
    holder: "entity",
    licence: "MIT",
    entity,
    assignment: doc(),
    operating: doc("Operating agreement"),
    contributorTerms: null,
  };
  for (const standing of [
    "unstated",
    "open",
    "founders-uncommitted",
    "founders-committed",
    "entity-unassigned",
    "entity-on-raise",
  ]) {
    const { headline, detail } = ipSummary(standing, base);
    assert.doesNotMatch(
      `${headline} ${detail}`,
      /holders own|you own/i,
      standing,
    );
  }
});

test("a founders-held project is told it carries the risk, and an unnamed licence is not open", () => {
  const founders = ipSummary("founders-uncommitted", null);
  assert.match(founders.detail, /legal risk personally/);
  assert.match(ipSummary("unstated", null).detail, /no claim/);
});

test("publishing writes only what is present, and round-trips", () => {
  const record = {
    v: 1,
    holder: "entity",
    licence: null,
    entity: { ...entity, registration: "MH-123" },
    assignment: doc(),
    operating: doc("Operating agreement"),
    contributorTerms: doc("Contributor terms"),
  };
  const content = ipRecordContent(record);
  assert.deepEqual(parseIpRecord(JSON.parse(JSON.stringify(content))), record);

  const bare = ipRecordContent({
    v: 1,
    holder: "founders",
    licence: null,
    entity: null,
    assignment: null,
    operating: null,
    contributorTerms: null,
  });
  assert.deepEqual(bare, { v: 1, holder: "founders" });
});

test("the editor refuses an open licence with no name and an entity with no name", () => {
  const blank = {
    v: 1,
    holder: "open",
    licence: null,
    entity: null,
    assignment: null,
    operating: null,
    contributorTerms: null,
  };
  assert.match(ipDraftProblem(blank), /licence/);
  assert.equal(ipDraftProblem({ ...blank, licence: "MIT" }), null);
  assert.match(ipDraftProblem({ ...blank, holder: "entity" }), /entity/);
  assert.equal(ipDraftProblem({ ...blank, holder: "founders" }), null);
});

test("the editor starts from a project with no entity, and from what is on record", () => {
  const fresh = ipDraftFromRecord(null);
  assert.equal(fresh.holder, "founders");
  assert.equal(fresh.assignment.url, "");
  const record = parseIpRecord({
    holder: "entity",
    entity: { ...entity, registration: "MH-1" },
    assignment: doc(),
  });
  const draft = ipDraftFromRecord(record);
  assert.equal(draft.entityName, "Nebula Series LLC");
  assert.equal(draft.entityRegistration, "MH-1");
  assert.equal(draft.assignment.sha256, SHA);
});

test("a draft makes a record, and a half-filled document is refused, not shrunk", () => {
  const draft = ipDraftFromRecord(null);
  assert.deepEqual(ipRecordFromDraft(draft).record.holder, "founders");

  const half = {
    ...draft,
    assignment: { title: "Commitment", url: "", sha256: "" },
  };
  assert.match(ipRecordFromDraft(half).problem, /assignment needs a title/);

  const whole = { ...draft, assignment: doc("Commitment") };
  assert.equal(ipRecordFromDraft(whole).record.assignment.title, "Commitment");

  const badHash = {
    ...draft,
    contributorTerms: { ...doc("Terms"), sha256: "nope" },
  };
  assert.match(ipRecordFromDraft(badHash).problem, /contributor terms/);
});

test("a draft for an entity needs its name and place, and ignores fields of other holders", () => {
  const base = { ...ipDraftFromRecord(null), holder: "entity" };
  assert.match(ipRecordFromDraft(base).problem, /entity/);
  const named = {
    ...base,
    entityName: " Nebula LLC ",
    entityPlace: "Marshall Islands",
  };
  const made = ipRecordFromDraft(named).record;
  assert.equal(made.entity.name, "Nebula LLC");
  // An operating agreement belongs to an entity; a licence to an open project.
  const founders = {
    ...named,
    holder: "founders",
    licence: "MIT",
    operating: doc("Operating agreement"),
  };
  const kept = ipRecordFromDraft(founders).record;
  assert.equal(kept.operating, null);
  assert.equal(kept.licence, null);
  assert.equal(kept.entity, null);
});
