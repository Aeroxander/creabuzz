import assert from "node:assert/strict";
import test from "node:test";

import {
  foundEvent,
  HELP_NOTE_MAX,
  helpNotices,
  helpRequest,
  offerCountLine,
  offeredLine,
  offerEvent,
  OFFERS_SHOWN,
  openHelpRequests,
  parseHelpSignal,
  replyEvent,
} from "./help-request.ts";
import { buildLaunches } from "../models.ts";
import { updateEvent } from "./weekly-update.ts";

const FOUNDER = "f".repeat(64);
const MATE = "c".repeat(64);
const ANN = "a".repeat(64);
const BEN = "b".repeat(64);
const UPDATE = "1".repeat(64);
const DAY = 86_400;
const ASK = { text: "Test sign-up.", size: "small", time: "" };
const TEAM = new Set([FOUNDER, MATE]);

let n = 0;
/** A signed record as the server returns it, from what a builder made. */
function signed(pubkey, built, at) {
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey,
    created_at: at,
    kind: 47003,
    tags: [["a", `37001:${FOUNDER}:demo`], ...built.tags],
    content: JSON.stringify(built.content),
    sig: "sig",
  };
}
const offer = (who, at, note = "") =>
  signed(
    who,
    offerEvent({ updateId: UPDATE, updateAuthor: FOUNDER, note }),
    at,
  );
const signals = (...events) => events.map(parseHelpSignal);
const view = (events, viewer = null) =>
  helpRequest({
    update: { id: UPDATE, help: ASK },
    signals: signals(...events),
    team: TEAM,
    viewer,
  });

test("an offer names the update and its author, and reads back as an offer", () => {
  const event = offer(ANN, 100, "  I have an old phone.  ");
  assert.deepEqual(event.tags.slice(1), [
    ["e", UPDATE],
    ["p", FOUNDER],
    ["help-offer", UPDATE],
  ]);
  assert.deepEqual(parseHelpSignal(event), {
    id: event.id,
    kind: "offer",
    target: UPDATE,
    author: ANN,
    at: 100,
    note: "I have an old phone.",
  });
});

test("an ordinary update, a record with two marks and a bad target are not help signals", () => {
  const plain = signed(FOUNDER, { content: { title: "Hi" }, tags: [] }, 1);
  assert.equal(parseHelpSignal(plain), null);
  const both = signed(
    ANN,
    {
      content: {},
      tags: [
        ["help-offer", UPDATE],
        ["help-found", UPDATE],
      ],
    },
    1,
  );
  assert.equal(parseHelpSignal(both), null);
  const bad = signed(ANN, { content: {}, tags: [["help-offer", "nope"]] }, 1);
  assert.equal(parseHelpSignal(bad), null);
});

test("a note is cut to one or two sentences' worth", () => {
  const event = offer(ANN, 1, "x".repeat(1000));
  assert.equal(JSON.parse(event.content).body.length, HELP_NOTE_MAX);
});

test("an update that asks for nothing has no card", () => {
  assert.equal(
    helpRequest({
      update: { id: UPDATE, help: null },
      signals: [],
      team: TEAM,
      viewer: ANN,
    }),
    null,
  );
});

test("before anyone answers, the request is open with no offers", () => {
  const v = view([], ANN);
  assert.equal(v.open, true);
  assert.equal(v.offerCount, 0);
  assert.equal(v.mine, null);
  assert.equal(v.viewerOnTeam, false);
});

test("a person sees their own offer; the team sees every offer, newest first", () => {
  const events = [offer(ANN, 100, "Me"), offer(BEN, 200, "Also me")];
  const ann = view(events, ANN);
  assert.equal(ann.mine.note, "Me");
  assert.equal(ann.offerCount, 2);
  const founder = view(events, FOUNDER);
  assert.equal(founder.viewerOnTeam, true);
  assert.equal(founder.mine, null);
  assert.deepEqual(
    founder.offers.map((o) => o.author),
    [BEN, ANN],
  );
});

test("one offer per person: their newest", () => {
  const v = view([offer(ANN, 100, "first"), offer(ANN, 300, "second")], ANN);
  assert.equal(v.offerCount, 1);
  assert.equal(v.mine.note, "second");
});

test("an offer taken back is gone: the person can offer again", () => {
  // Withdrawing deletes the record, so the server no longer returns it.
  const v = view([offer(BEN, 200)], ANN);
  assert.equal(v.mine, null);
  assert.equal(v.offerCount, 1);
});

test("the team's own records are not offers, and offers on another update are ignored", () => {
  const other = signed(
    BEN,
    offerEvent({ updateId: "2".repeat(64), updateAuthor: FOUNDER, note: "" }),
    50,
  );
  const v = view([offer(MATE, 100), other], FOUNDER);
  assert.equal(v.offerCount, 0);
});

test("only the team can mark Help found, and it closes the request", () => {
  const mark = (who, at) => signed(who, foundEvent({ updateId: UPDATE }), at);
  assert.equal(view([mark(ANN, 500)], ANN).open, true);
  const closed = view([offer(ANN, 100), mark(MATE, 500)], ANN);
  assert.equal(closed.open, false);
  assert.equal(closed.foundAt, 500);
  // What was offered before stays on the record.
  assert.equal(closed.mine.at, 100);
});

test("the team's replies sit under the offer they answer, oldest first; anyone else's are ignored", () => {
  const first = offer(ANN, 100);
  const reply = (who, at, note) =>
    signed(who, replyEvent({ offerId: first.id, offerAuthor: ANN, note }), at);
  const v = view(
    [
      first,
      reply(FOUNDER, 300, "Later"),
      reply(FOUNDER, 200, "Thanks!"),
      reply(BEN, 250, "I am not the team"),
    ],
    ANN,
  );
  assert.deepEqual(
    v.mine.replies.map((r) => r.note),
    ["Thanks!", "Later"],
  );
});

test("the list is capped and says how many there are in all", () => {
  const many = Array.from({ length: OFFERS_SHOWN + 5 }, (_, i) =>
    offer(i.toString(16).padStart(64, "9"), 100 + i),
  );
  const v = view(many, FOUNDER);
  assert.equal(v.offers.length, OFFERS_SHOWN);
  assert.equal(v.offerCount, OFFERS_SHOWN + 5);
});

test("the lines people read", () => {
  const now = 100 * DAY;
  assert.equal(offeredLine(now - 60, now), "You offered to help today.");
  assert.equal(offeredLine(now - DAY, now), "You offered to help yesterday.");
  assert.equal(
    offeredLine(now - 2 * DAY, now),
    "You offered to help 2 days ago.",
  );
  assert.equal(offerCountLine(0), null);
  assert.equal(offerCountLine(1), "1 person offered to help");
  assert.equal(offerCountLine(3), "3 people offered to help");
});

test("nothing a card can send or say names Shares or money", () => {
  const words = JSON.stringify([
    offerEvent({ updateId: UPDATE, updateAuthor: FOUNDER, note: "" }),
    replyEvent({ offerId: UPDATE, offerAuthor: ANN, note: "" }),
    foundEvent({ updateId: UPDATE }),
    offeredLine(0, DAY),
    offerCountLine(2),
  ]);
  assert.doesNotMatch(words, /share|earn|\$|paid|reward/i);
});

/** A project as the app builds it from the server's records. */
function project(slug, extra = []) {
  const record = {
    id: `rec-${slug}`.padEnd(64, "0"),
    pubkey: FOUNDER,
    created_at: 10,
    kind: 37001,
    tags: [
      ["d", slug],
      ["name", slug],
      ["team", MATE, "Builder"],
    ],
    content: JSON.stringify({ pitch: "p", stage: "live" }),
    sig: "sig",
  };
  return buildLaunches([record, ...extra]);
}
function update(slug, who, at, help) {
  const built = updateEvent({
    title: `Week ${at}`,
    done: "Did things.",
    next: "",
    body: "",
    help,
    helpSize: "large",
    helpTime: "",
  });
  n += 1;
  return {
    id: n.toString(16).padStart(64, "0"),
    pubkey: who,
    created_at: at,
    kind: 47003,
    tags: [["a", `37001:${FOUNDER}:${slug}`], ...built.tags],
    content: JSON.stringify(built.content),
    sig: "sig",
  };
}
const answer = (slug, who, built, at) => ({
  ...signed(who, built, at),
  tags: [["a", `37001:${FOUNDER}:${slug}`], ...built.tags],
});

test("read from the server's records: offers, replies and Help found never count as updates", () => {
  const ask = update("demo", FOUNDER, 100, "A tester.");
  const offered = answer(
    "demo",
    ANN,
    offerEvent({ updateId: ask.id, updateAuthor: FOUNDER, note: "Me" }),
    200,
  );
  const replied = answer(
    "demo",
    FOUNDER,
    replyEvent({ offerId: offered.id, offerAuthor: ANN, note: "Thanks" }),
    300,
  );
  const found = answer("demo", FOUNDER, foundEvent({ updateId: ask.id }), 400);
  const [launch] = project("demo", [ask, offered, replied, found]);
  assert.deepEqual(
    launch.updates.map((u) => u.id),
    [ask.id],
  );
  assert.deepEqual(launch.updates[0].help, {
    text: "A tester.",
    size: "large",
    time: "",
  });
  assert.deepEqual(launch.helpSignals.map((s) => s.kind).sort(), [
    "found",
    "offer",
    "reply",
  ]);
});

test("open requests: each project's newest open one, newest first, never a closed or outsider's one", () => {
  const a1 = update("alpha", FOUNDER, 100, "Old ask.");
  const a2 = update("alpha", MATE, 300, "New ask.");
  const b1 = update("beta", FOUNDER, 200, "Beta ask.");
  const c1 = update("gamma", FOUNDER, 400, "Gamma ask.");
  const cFound = answer("gamma", FOUNDER, foundEvent({ updateId: c1.id }), 450);
  const d1 = update("delta", ANN, 500, "Not the team.");
  const launches = [
    ...project("alpha", [a1, a2]),
    ...project("beta", [b1]),
    ...project("gamma", [c1, cFound]),
    ...project("delta", [d1]),
    ...project("quiet", [update("quiet", FOUNDER, 600, "")]),
  ];
  const open = openHelpRequests(launches, 5);
  assert.deepEqual(
    open.map((r) => [r.project.id, r.ask.text]),
    [
      ["alpha", "New ask."],
      ["beta", "Beta ask."],
    ],
  );
  assert.equal(openHelpRequests(launches, 1).length, 1);
});

test("the team is told about offers, and a person about replies to their own offer", () => {
  const ask = update("demo", FOUNDER, 100, "A tester.");
  const offered = answer(
    "demo",
    ANN,
    offerEvent({ updateId: ask.id, updateAuthor: FOUNDER, note: "Me" }),
    200,
  );
  const replied = answer(
    "demo",
    FOUNDER,
    replyEvent({ offerId: offered.id, offerAuthor: ANN, note: "Thanks" }),
    300,
  );
  const launches = project("demo", [ask, offered, replied]);
  const forFounder = helpNotices(launches, FOUNDER);
  assert.deepEqual(
    forFounder.map((x) => [x.kind, x.actor, x.note, x.updateTitle]),
    [["offer", ANN, "Me", "Week 100"]],
  );
  // A teammate is on the asking side too.
  assert.equal(helpNotices(launches, MATE).length, 1);
  assert.deepEqual(
    helpNotices(launches, ANN).map((x) => [x.kind, x.actor, x.note]),
    [["reply", FOUNDER, "Thanks"]],
  );
  // Someone who neither asked nor offered hears nothing.
  assert.deepEqual(helpNotices(launches, BEN), []);
});
