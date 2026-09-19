#!/usr/bin/env node
// prime-acp-shim — ACP stdio server that delegates to `prime-agent --mode rpc`.
//
// Lets buzz-acp (or Zed, JetBrains, any ACP client) drive Prime Agent:
//   buzz-acp --agent-command prime-acp-shim   (zero-arg runtime)
//
// Protocol mapping:
//   initialize        -> { protocolVersion: 2, agentCapabilities, _meta.steering }
//   session/new       -> { sessionId } (prime-agent child spawned eagerly so a
//                        missing binary fails fast instead of hanging a turn)
//   session/prompt    -> RPC `prompt`; RPC text/tool events stream back as
//                        ACP `session/update` (agent_message_chunk / tool_call /
//                        agent_thought_chunk); RPC `agent_end` -> {stopReason}
//   session/cancel    -> RPC `abort`; pending prompt answers `cancelled`
//   _session/steering -> RPC `steer` (queued mid-turn steering)
//
// Hardening (mirrors VISION_AGENT.md):
// - process-group kill for every prime-agent child on every exit path
// - 10 MB line cap on both ACP stdin and RPC stdout (fail closed)
// - backend failures answer the pending prompt with a JSON-RPC error —
//   never a fake `end_turn` with an empty transcript
// - secrets travel via inherited env only; nothing is logged or echoed
//
// Zero dependencies (Node built-ins only).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MAX_LINE_BYTES = 10_000_000;
const PROTOCOL_VERSION = 2;
const PRIME_COMMAND = process.env.PRIME_AGENT_COMMAND ?? "prime-agent";

const sessions = new Map(); // sessionId -> { child, pending, rpcBuf, sawEnd, streaming }
let stdinBuf = "";

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`prime-acp-shim fatal: ${error?.message ?? error}`);
    process.exit(1);
  });
}

async function main() {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onStdinData);
  process.stdin.on("error", () => process.exit(1));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", shutdown);
}

function shutdown() {
  for (const session of sessions.values()) killTree(session.child);
  sessions.clear();
}

function onStdinData(chunk) {
  stdinBuf += chunk;
  if (stdinBuf.length > MAX_LINE_BYTES + 1024) {
    // Fail closed: an over-long line can never be a valid frame.
    console.error("prime-acp-shim: stdin line cap exceeded");
    process.exit(1);
  }
  let index;
  while ((index = stdinBuf.indexOf("\n")) !== -1) {
    const line = stdinBuf.slice(0, index).replace(/\r$/, "");
    stdinBuf = stdinBuf.slice(index + 1);
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // Malformed frame: ignore, never crash the harness loop.
    }
    void handleMessage(msg).catch((error) => {
      if (msg?.id !== undefined && msg?.id !== null) {
        respondError(msg.id, -32000, `handler failure: ${error?.message ?? error}`);
      }
    });
  }
}

async function handleMessage(msg) {
  if (typeof msg !== "object" || msg === null) return;
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize":
      if (isRequest) {
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          agentInfo: { name: "prime-agent", version: "shim" },
          _meta: { steering: { supported: true } },
        });
      }
      return;
    case "session/new":
      if (isRequest) await handleSessionNew(id, params ?? {});
      return;
    case "session/prompt":
      if (isRequest) await handleSessionPrompt(id, params ?? {});
      return;
    case "session/cancel":
      handleSessionCancel(params ?? {});
      return; // notification: no response
    case "_session/steering":
      handleSteering(params ?? {});
      return; // notification: no response
    case "authenticate":
      if (isRequest) respondError(id, -32601, "no auth methods advertised");
      return;
    default:
      if (isRequest) respondError(id, -32601, `unknown method: ${method ?? "missing"}`);
      return;
  }
}

async function handleSessionNew(id, params) {
  const sessionId = `prime-${randomUUID()}`;
  const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : process.cwd();
  try {
    const child = spawnPrime(cwd);
    const session = {
      id: sessionId,
      child,
      cwd,
      pending: null, // { id, sessionId }
      rpcBuf: "",
      sawEnd: false,
      streaming: false,
      stderrTail: "",
    };
    sessions.set(sessionId, session);
    attachChild(session);
    // Prime the child with an empty-line-tolerant handshake: prime-agent RPC
    // needs no hello frame; record liveness via the spawn itself.
    respond(id, { sessionId });
  } catch (error) {
    respondError(id, -32000, `prime-agent spawn failed: ${error?.message ?? error}`);
  }
}

async function handleSessionPrompt(id, params) {
  const sessionId = params.sessionId;
  const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (!session) {
    respondError(id, -32000, "unknown sessionId");
    return;
  }
  if (session.pending) {
    respondError(id, -32000, "a prompt is already in flight for this session");
    return;
  }
  if (!isChildAlive(session.child)) {
    sessions.delete(sessionId);
    respondError(id, -32000, "prime-agent process exited unexpectedly");
    return;
  }
  const text = extractPromptText(params.prompt);
  session.pending = { id };
  session.sawEnd = false;
  session.streaming = true;
  const streamingBehavior = session.streamedOnce ? "steer" : undefined;
  session.streamedOnce = true;
  sendRpc(session, {
    type: "prompt",
    message: text,
    ...(streamingBehavior ? { streamingBehavior } : {}),
  });
}

function handleSessionCancel(params) {
  const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
  if (!session?.pending) return;
  sendRpc(session, { type: "abort" });
  const pending = session.pending;
  session.pending = null;
  session.streaming = false;
  respond(pending.id, { stopReason: "cancelled" });
}

function handleSteering(params) {
  const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
  if (!session || !isChildAlive(session.child)) return;
  const message = extractPromptText(params.message ?? params.prompt ?? params.text);
  if (!message) return;
  if (session.streaming) {
    sendRpc(session, { type: "steer", message });
  } else {
    // Idle session: steering becomes a normal turn so the message is not lost.
    session.pending = session.pending ?? { id: `steer-${randomUUID()}`, steeringOnly: true };
    sendRpc(session, { type: "prompt", message });
  }
}

// ── prime-agent child management ────────────────────────────────────────────

function spawnPrime(cwd) {
  const extra = [];
  if (process.env.PRIME_AGENT_PROVIDER) extra.push("--provider", process.env.PRIME_AGENT_PROVIDER);
  if (process.env.PRIME_AGENT_MODEL) extra.push("--model", process.env.PRIME_AGENT_MODEL);
  return spawn(PRIME_COMMAND, ["--mode", "rpc", ...extra], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

function isChildAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function killTree(child) {
  if (!child || !isChildAlive(child)) return;
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
      return;
    }
  } catch {
    // Fall through to direct kill.
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}

function attachChild(session) {
  const { child } = session;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => onRpcData(session, String(chunk)));
  child.stderr.on("data", (chunk) => {
    session.stderrTail = `${session.stderrTail}${chunk}`.slice(-8000);
  });
  child.on("error", (error) => failPending(session, `prime-agent process error: ${error?.message ?? error}`));
  child.on("close", (code, signal) => {
    if (session.pending) {
      const detail = session.stderrTail.trim().split("\n").slice(-3).join("\n");
      failPending(
        session,
        `prime-agent exited (code ${code ?? "?"}${signal ? `, ${signal}` : ""}) mid-turn${detail ? `: ${detail}` : ""}`,
      );
    }
    sessions.delete(session.id);
  });
}

function sendRpc(session, obj) {
  try {
    session.child.stdin.write(`${JSON.stringify(obj)}\n`);
  } catch (error) {
    failPending(session, `stdin write failed: ${error?.message ?? error}`);
  }
}

function onRpcData(session, chunk) {
  session.rpcBuf += chunk;
  if (session.rpcBuf.length > MAX_LINE_BYTES + 1024) {
    failPending(session, "rpc line cap exceeded (10 MB)");
    killTree(session.child);
    return;
  }
  let index;
  while ((index = session.rpcBuf.indexOf("\n")) !== -1) {
    const line = session.rpcBuf.slice(0, index).replace(/\r$/, "");
    session.rpcBuf = session.rpcBuf.slice(index + 1);
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // Non-JSON line: ignore, never fail the turn on it.
    }
    onRpcEvent(session, event);
  }
}

function onRpcEvent(session, event) {
  if (typeof event !== "object" || event === null) return;
  // RPC command responses carry `type: "response"` — turns resolve on
  // `agent_end`, not on the prompt acceptance, so responses are ignored
  // unless they report a rejection (success: false).
  if (event.type === "response") {
    if (event.success === false && session.pending) {
      failPending(session, `prompt rejected: ${event.error ?? "unknown"}`);
    }
    return;
  }
  forwardAsAcpUpdate(session, event);
  if (event.type === "agent_end") {
    const pending = session.pending;
    session.pending = null;
    session.streaming = false;
    if (pending && !pending.steeringOnly) respond(pending.id, { stopReason: "end_turn" });
    else if (pending?.steeringOnly) {
      // Steering-while-idle turn: report completion as a notification-less
      // no-op — the steered text was already delivered to the model.
    }
  }
}

/** Best-effort RPC -> ACP update fan-out. Unknown shapes are skipped. */
function forwardAsAcpUpdate(session, event) {
  switch (event.type) {
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (!delta || typeof delta !== "object") return;
      if (delta.type === "text_delta" && typeof delta.delta === "string" && delta.delta !== "") {
        notify("session/update", {
          sessionId: session.id,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.delta } },
        });
      } else if (delta.type === "thinking_delta" && typeof delta.delta === "string" && delta.delta !== "") {
        notify("session/update", {
          sessionId: session.id,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.delta } },
        });
      } else if (delta.type === "toolcall_end" && delta.toolCall) {
        const tc = delta.toolCall;
        notify("session/update", {
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: String(tc.id ?? tc.toolCallId ?? randomUUID()),
            title: String(tc.name ?? "tool"),
            kind: "other",
            status: "in_progress",
          },
        });
      }
      return;
    }
    case "tool_execution_end": {
      notify("session/update", {
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: String(event.toolCallId ?? "unknown"),
          status: event.isError ? "failed" : "completed",
        },
      });
      return;
    }
    case "message_end": {
      // Non-streaming backends only emit the finished message: forward its
      // text so the harness idle clock still observes turn activity.
      const message = event.message;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        const text = message.content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
        if (text !== "") {
          notify("session/update", {
            sessionId: session.id,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        }
      }
      return;
    }
    default:
      return;
  }
}

/** Fail the pending prompt with a JSON-RPC error — never a fake end_turn. */
function failPending(session, message) {
  const pending = session.pending;
  session.pending = null;
  session.streaming = false;
  if (pending && !pending.steeringOnly) respondError(pending.id, -32000, message);
}

// ── ACP framing ─────────────────────────────────────────────────────────────

/** Extract display text from an ACP prompt (array of content blocks). */
function extractPromptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") {
        if (typeof block.text === "string") return block.text;
        if (typeof block.data === "string") return block.data;
      }
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message: String(message).slice(0, 2000) } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

// Exposed for tests (imported without running main twice is guarded by shape).
export const __test__ = { extractPromptText, MAX_LINE_BYTES, PROTOCOL_VERSION };
