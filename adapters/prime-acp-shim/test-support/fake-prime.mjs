#!/usr/bin/env node
// Scripted fake `prime-agent --mode rpc` for tests.
//
// Speaks just enough RPC to exercise the real spawn/parse path:
//   prompt   -> acceptance + agent_start + one assistant message + agent_end
//   steer    -> acceptance (queued; no immediate events)
//   abort    -> agent_end (so cancelled turns still terminate the child)
//   get_session_stats -> acceptance (usage covered via message payloads)
//
// Modes via FAKE_MODE env:
//   ok (default)            full successful turn, usage input=11 output=7
//   reject-once             first prompt of the process is rejected with an
//                           "unknown session" error, later prompts succeed.
//                           Marker state lives in FAKE_MARKER file path so a
//                           *fresh process* (adapter retry) succeeds.
//   hang                    accept prompts, never emit agent_end (timeout tests)
//   exit-dirty              exit(3) without agent_end (outcome tests)
//   unknown-session-always  every prompt rejected (retry-exhaustion tests)

import { existsSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_MODE ?? "ok";
const marker = process.env.FAKE_MARKER;

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let index;
  while ((index = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, index).replace(/\r$/, "");
    buf = buf.slice(index + 1);
    if (line.trim() === "") continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    onCommand(cmd);
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const ASSISTANT = {
  role: "assistant",
  content: [{ type: "text", text: "fake turn complete" }],
  usage: { input: 11, output: 7 },
};

// Test hook: echo named env values into the transcript so tests can prove
// which config env keys reached the child (FAKE_ECHO_VARS="A,B").
function echoedEnv() {
  const names = String(process.env.FAKE_ECHO_VARS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return "";
  return `\n[env ${names.map((n) => `${n}=${process.env[n] ?? "<absent>"}`).join(" ")}]`;
}

function onCommand(cmd) {
  switch (cmd?.type) {
    case "prompt": {
      if (mode === "hang") {
        send({ type: "response", command: "prompt", success: true });
        return;
      }
      if (mode === "exit-dirty") {
        send({ type: "response", command: "prompt", success: true });
        process.stderr.write("fake boom\n");
        process.exit(3);
        return;
      }
      if (mode === "unknown-session-always") {
        send({ type: "response", command: "prompt", success: false, error: "unknown session gone" });
        return;
      }
      if (mode === "reject-once") {
        if (marker && !existsSync(marker)) {
          writeFileSync(marker, "rejected");
          send({ type: "response", command: "prompt", success: false, error: "unknown session abc123" });
          return;
        }
      }
      send({ type: "response", command: "prompt", success: true });
      send({ type: "agent_start" });
      const text = `fake turn complete${echoedEnv()}`;
      // Streaming delta first (like the real backend), then the full message.
      send({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
      });
      const message = {
        ...ASSISTANT,
        content: [{ type: "text", text }],
      };
      send({ type: "message_end", message });
      send({ type: "agent_end", messages: [message] });
      return;
    }
    case "steer":
    case "follow_up":
      send({ type: "response", command: cmd.type, success: true });
      return;
    case "abort":
      send({ type: "response", command: "abort", success: true });
      send({ type: "agent_end", messages: [] });
      return;
    case "get_session_stats":
      send({
        type: "response",
        command: "get_session_stats",
        success: true,
        data: { tokens: { input: 11, output: 7 } },
      });
      return;
    default:
      send({ type: "response", command: cmd?.type ?? "?", success: false, error: "unknown command" });
      return;
  }
}
