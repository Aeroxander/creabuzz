import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReporter,
  installErrorReporting,
  makeReport,
  MAX_MESSAGE,
  MAX_PER_MINUTE,
  MAX_PER_SESSION,
  MAX_STACK,
  reportEndpoint,
  reportRenderError,
  scrub,
} from "./error-report.ts";

const HEX = "ab".repeat(32);

test("keys, ids and addresses are blanked wherever they appear in an error", () => {
  const nsec = `nsec1${"q".repeat(58)}`;
  const text = `failed for ${nsec} and ${HEX} and 0x${"c".repeat(40)} on npub1${"x".repeat(58)}`;
  const clean = scrub(text);
  assert.doesNotMatch(clean, /nsec1|npub1|ab{10}|c{20}/);
  assert.match(clean, /\[key\].*\[id\].*\[address\].*\[key\]/);
  // Ordinary words are left alone.
  assert.equal(scrub("Network request failed"), "Network request failed");
});

test("only a safe collector address turns reporting on", () => {
  assert.equal(reportEndpoint(undefined), null);
  assert.equal(reportEndpoint("   "), null);
  assert.equal(reportEndpoint("not a url"), null);
  assert.equal(
    reportEndpoint("http://errors.example.com/c"),
    null,
    "plain http over a network",
  );
  assert.equal(reportEndpoint("ftp://errors.example.com"), null);
  assert.equal(
    reportEndpoint("https://errors.example.com/c"),
    "https://errors.example.com/c",
  );
  assert.equal(
    reportEndpoint("http://localhost:9000/c"),
    "http://localhost:9000/c",
  );
  assert.equal(
    reportEndpoint("http://127.0.0.1:9000/c"),
    "http://127.0.0.1:9000/c",
  );
});

test("a note says what, where and when, with no query, no fragment and nothing secret", () => {
  const error = new Error(`could not load ${HEX}`);
  const note = makeReport({
    kind: "error",
    error,
    page: `/c/alpha.example.com?invite=secret#token=${HEX}`,
    now: 1_700_000_000_000,
    release: "2026.10.13",
  });
  assert.equal(note.kind, "error");
  assert.equal(note.message, "could not load [id]");
  assert.equal(note.page, "/c/alpha.example.com");
  assert.equal(note.at, 1_700_000_000);
  assert.equal(note.release, "2026.10.13");
  assert.deepEqual(Object.keys(note).sort(), [
    "at",
    "kind",
    "message",
    "page",
    "release",
    "stack",
  ]);
  assert.doesNotMatch(JSON.stringify(note), /secret|token=/);
});

test("anything can be thrown: strings, objects and nothing at all are described without failing", () => {
  const base = { kind: "rejection", page: "/", now: 0 };
  assert.equal(
    makeReport({ ...base, error: "plain text" }).message,
    "plain text",
  );
  assert.equal(
    makeReport({ ...base, error: { code: 7 } }).message,
    '{"code":7}',
  );
  assert.equal(makeReport({ ...base, error: undefined }).message, "undefined");
  const circular = {};
  circular.self = circular;
  assert.equal(
    typeof makeReport({ ...base, error: circular }).message,
    "string",
  );
});

test("messages and stacks are cut to length", () => {
  const error = new Error("m".repeat(5000));
  error.stack = `Error: x\n${"s".repeat(9000)}`;
  const note = makeReport({ kind: "error", error, page: "/", now: 0 });
  assert.equal(note.message.length, MAX_MESSAGE);
  assert.equal(note.stack.length, MAX_STACK);
});

function reporter(clock = { t: 0 }) {
  const sent = [];
  const r = createReporter({
    send: (report) => sent.push(report),
    page: () => "/p",
    now: () => clock.t,
  });
  return { r, sent, clock };
}

test("the same error is told once, however often it happens", () => {
  const { r, sent } = reporter();
  const boom = () => new Error("boom");
  const e = boom();
  assert.equal(r.report("error", e), true);
  assert.equal(r.report("error", e), false);
  assert.equal(
    r.report("error", boom()),
    false,
    "the same error thrown again from the same place is a repeat",
  );
  assert.equal(r.report("error", new Error("different")), true);
  assert.equal(sent.length, 2);
});

test("a broken screen cannot flood the collector: a few a minute, a few dozen a visit", () => {
  const { r, sent, clock } = reporter();
  for (let i = 0; i < MAX_PER_MINUTE + 3; i += 1)
    r.report("error", new Error(`e${i}`));
  assert.equal(sent.length, MAX_PER_MINUTE);

  // A minute later there is room again.
  clock.t += 61_000;
  assert.equal(r.report("error", new Error("later")), true);

  // But never more than the visit's total.
  let total = sent.length;
  for (let i = 0; i < 100; i += 1) {
    clock.t += 61_000;
    if (r.report("error", new Error(`more${i}`))) total += 1;
  }
  assert.equal(total, MAX_PER_SESSION);
});

test("a collector that throws never reaches the app", () => {
  const r = createReporter({
    send: () => {
      throw new Error("collector down");
    },
    page: () => "/",
    now: () => 0,
  });
  assert.doesNotThrow(() => r.report("error", new Error("x")));
});

function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type, event) => listeners.get(type)?.(event),
    has: (type) => listeners.has(type),
  };
}

test("with no collector nothing is listened to", () => {
  const w = fakeWindow();
  const stop = installErrorReporting({
    endpoint: null,
    target: w,
    fetchImpl: () => assert.fail("sent"),
    page: () => "/",
  });
  assert.equal(w.has("error"), false);
  assert.equal(w.has("unhandledrejection"), false);
  stop();
});

test("with a collector, uncaught errors and unhandled rejections are posted as small notes and nothing else", async () => {
  const w = fakeWindow();
  const calls = [];
  const stop = installErrorReporting({
    endpoint: "https://errors.example.com/c",
    target: w,
    fetchImpl: (url, init) => {
      calls.push({ url, init });
      return Promise.reject(new Error("collector down"));
    },
    page: () => "/launchpad",
    now: () => 5000,
    release: "r1",
  });
  w.fire("error", { error: new Error("boom") });
  w.fire("unhandledrejection", { reason: "nobody listened" });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://errors.example.com/c");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "omit", "no cookies go with it");
  assert.equal(calls[0].init.keepalive, true);
  const first = JSON.parse(calls[0].init.body);
  assert.equal(first.kind, "error");
  assert.equal(first.message, "boom");
  assert.equal(first.page, "/launchpad");
  const second = JSON.parse(calls[1].init.body);
  assert.equal(second.kind, "rejection");
  assert.equal(second.message, "nobody listened");

  // A screen that caught its own crash can report it too, and stopping removes it all.
  reportRenderError(new Error("screen crashed"));
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[2].init.body).kind, "render");
  stop();
  assert.equal(w.has("error"), false);
  reportRenderError(new Error("after stop"));
  assert.equal(calls.length, 3, "nothing is sent once stopped");
});
