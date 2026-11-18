import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";

import { makePrimeCommand } from "./test-support/make-prime-command.mjs";

const SHIM = new URL("./prime-acp-shim.mjs", import.meta.url).pathname;

/** Minimal ACP client over the shim's stdio. */
function startShim(primeCommand) {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, PRIME_AGENT_COMMAND: primeCommand },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // drain; fatal errors surface via exit code
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let index;
    while ((index = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, index);
      buf = buf.slice(index + 1);
      if (line.trim() === "") continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }
      }, 8000).unref();
    });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  return { child, request, notify, notifications };
}

test("initialize advertises ACP v2 with steering", async (t) => {
  const { child, request } = startShim(makePrimeCommand());
  t.after(() => child.kill("SIGKILL"));
  const res = await request("initialize", { protocolVersion: 2 });
  assert.equal(res.result.protocolVersion, 2);
  assert.equal(res.result._meta.steering.supported, true);
});

test("session/new + session/prompt drives a full turn", async (t) => {
  const { child, request, notifications } = startShim(makePrimeCommand());
  t.after(() => child.kill("SIGKILL"));
  await request("initialize", { protocolVersion: 2 });
  const created = await request("session/new", { cwd: tmpdir(), mcpServers: [] });
  assert.match(created.result.sessionId, /^prime-/);
  const answered = await request("session/prompt", {
    sessionId: created.result.sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  assert.deepEqual(answered.result, { stopReason: "end_turn" });
  const updates = notifications.filter((n) => n.method === "session/update");
  assert.ok(updates.length > 0, "expected session/update activity during the turn");
  const chunk = updates.find((n) => n.params?.update?.sessionUpdate === "agent_message_chunk");
  assert.ok(chunk, "expected an agent_message_chunk update");
});

test("session/cancel aborts the turn with cancelled", async (t) => {
  const { child, request } = startShim(makePrimeCommand({ FAKE_MODE: "hang" }));
  t.after(() => child.kill("SIGKILL"));
  await request("initialize", { protocolVersion: 2 });
  const created = await request("session/new", { cwd: tmpdir(), mcpServers: [] });
  const promptP = request("session/prompt", {
    sessionId: created.result.sessionId,
    prompt: [{ type: "text", text: "hang on" }],
  });
  // Give the turn a beat to go in-flight, then cancel (notification: no id).
  await new Promise((r) => setTimeout(r, 500));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: created.result.sessionId } })}\n`,
  );
  const answered = await promptP;
  assert.deepEqual(answered.result, { stopReason: "cancelled" });
});

test("unknown session and unknown method are protocol errors, not crashes", async (t) => {
  const { child, request } = startShim(makePrimeCommand());
  t.after(() => child.kill("SIGKILL"));
  await request("initialize", { protocolVersion: 2 });
  const badSession = await request("session/prompt", {
    sessionId: "prime-nope",
    prompt: [{ type: "text", text: "hi" }],
  });
  assert.ok(badSession.error, "expected JSON-RPC error for unknown session");
  const badMethod = await request("definitely/not-a-method", {});
  assert.equal(badMethod.error?.code, -32601);
  // The shim still serves afterwards — the errors were not fatal.
  const created = await request("session/new", { cwd: tmpdir(), mcpServers: [] });
  assert.match(created.result.sessionId, /^prime-/);
});

test("backend dirty exit fails the turn — never fake end_turn", async (t) => {
  const { child, request } = startShim(makePrimeCommand({ FAKE_MODE: "exit-dirty" }));
  t.after(() => child.kill("SIGKILL"));
  await request("initialize", { protocolVersion: 2 });
  const created = await request("session/new", { cwd: tmpdir(), mcpServers: [] });
  const answered = await request("session/prompt", {
    sessionId: created.result.sessionId,
    prompt: [{ type: "text", text: "hi" }],
  });
  assert.ok(answered.error, "expected JSON-RPC error for dirty backend exit");
  assert.match(answered.error.message, /exited/);
});
