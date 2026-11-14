import assert from "node:assert/strict";
import test from "node:test";

import {
  checkServer,
  parseServerAddress,
  saveServerAddress,
} from "./server-switch.ts";

test("a server address is read from a bare host, a host with a port, or a full address", () => {
  assert.deepEqual(parseServerAddress("  community.example.com "), {
    ok: true,
    wsUrl: "ws://community.example.com",
    host: "community.example.com",
  });
  assert.deepEqual(parseServerAddress("relay.example.com:3000"), {
    ok: true,
    wsUrl: "ws://relay.example.com:3000",
    host: "relay.example.com:3000",
  });
  assert.deepEqual(parseServerAddress("https://my-film.creaton.example/"), {
    ok: true,
    wsUrl: "wss://my-film.creaton.example",
    host: "my-film.creaton.example",
  });
  assert.equal(parseServerAddress("localhost:3001").ok, true);
  assert.equal(parseServerAddress("my-film.localhost:3199").ok, true);
  assert.equal(parseServerAddress("127.0.0.1:3001").ok, true);
});

test("a typo is refused before anything is saved", () => {
  for (const typo of [
    "",
    "   ",
    "community example com",
    "communityexamplecom",
    "community..example.com",
    "community.example.com/rooms",
    "community.example.com?x=1",
    "user:pass@community.example.com",
    "-bad.example.com",
    "example.123",
    "http://",
  ]) {
    const parsed = parseServerAddress(typo);
    assert.equal(parsed.ok, false, `accepted ${JSON.stringify(typo)}`);
    assert.match(parsed.problem, /\S/);
  }
});

/** A stand-in for the browser's connection: `then(socket)` decides what the server does once it is dialled. */
function server(then) {
  const opened = [];
  const connect = (url) => {
    const listeners = { open: [], error: [], close: [] };
    const socket = {
      url,
      closed: false,
      addEventListener: (type, fn) => listeners[type].push(fn),
      close() {
        socket.closed = true;
      },
      emit: (type) => {
        for (const fn of listeners[type]) fn();
      },
    };
    opened.push(socket);
    queueMicrotask(() => then(socket));
    return socket;
  };
  return { connect, opened };
}

test("a server that accepts a connection answers, and the connection is closed again", async () => {
  const { connect, opened } = server((socket) => socket.emit("open"));
  const result = await checkServer("wss://community.example.com", { connect });
  assert.deepEqual(result, { ok: true });
  assert.equal(opened.length, 1);
  // The check dials the address the app will use, not a web page on it.
  assert.equal(opened[0].url, "wss://community.example.com");
  assert.equal(opened[0].closed, true);
});

test("a dead or parked address, or one the browser will not dial, is not an answer", async () => {
  const refusals = [
    server((socket) => socket.emit("error")).connect,
    // A parked page answers the connection with a web page: the browser reports it closed, never open.
    server((socket) => socket.emit("close")).connect,
    () => {
      throw new DOMException("insecure", "SecurityError");
    },
  ];
  for (const connect of refusals) {
    const result = await checkServer("ws://typo.example.com", { connect });
    assert.equal(result.ok, false);
    assert.match(result.problem, /typo\.example\.com didn't answer/);
  }
});

test("an error after the connection opened does not undo the answer", async () => {
  const { connect } = server((socket) => {
    socket.emit("open");
    socket.emit("error");
    socket.emit("close");
  });
  assert.deepEqual(await checkServer("ws://ok.example.com", { connect }), {
    ok: true,
  });
});

test("a server that never answers is given up on after the time limit, and hung up on", async () => {
  const started = Date.now();
  const { connect, opened } = server(() => {});
  const result = await checkServer("ws://silent.example.com", {
    connect,
    timeoutMs: 50,
  });
  assert.equal(result.ok, false);
  assert.match(result.problem, /didn't answer in time/);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(opened[0].closed, true);
});

test("a check the page stops is hung up on and never reports an answer", async () => {
  const controller = new AbortController();
  let socket;
  const { connect } = server((s) => {
    socket = s;
  });
  const pending = checkServer("ws://slow.example.com", {
    connect,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  // The server opening afterwards changes nothing.
  socket.emit("open");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(socket.closed, true);

  const already = new AbortController();
  already.abort();
  let dialled = false;
  const late = await checkServer("ws://slow.example.com", {
    connect: () => {
      dialled = true;
      return server(() => {}).connect("x");
    },
    signal: already.signal,
  });
  assert.equal(late.ok, false);
  assert.equal(dialled, false);
});

test("a browser that refuses to keep the address says so instead of reloading", () => {
  assert.equal(
    saveServerAddress("ws://a.example.com", () => {}),
    null,
  );
  const problem = saveServerAddress("ws://a.example.com", () => {
    throw new DOMException("blocked", "SecurityError");
  });
  assert.match(problem, /didn't let the address be saved/);
});
