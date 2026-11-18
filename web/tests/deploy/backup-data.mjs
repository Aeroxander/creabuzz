// Data for scripts/test-compose-backup.sh: puts a signed post and an uploaded image on a running server, and later
// checks that both are there (or, with `absent`, that they are not), through the server's own API.
//
//   node backup-data.mjs seed   <http-base> <hex-key>           prints {"event": …, "sha256": …}
//   node backup-data.mjs check  <http-base> <hex-key> <json>    exits 1 unless both are there and match
//   node backup-data.mjs absent <http-base> <hex-key> <json>    exits 1 if either is there
import { createHash } from "node:crypto";

import { finalizeEvent } from "nostr-tools/pure";

const [mode, base, hexKey, saved] = process.argv.slice(2);
if (!mode || !base || !hexKey) {
  console.error(
    "usage: backup-data.mjs seed|check|absent <http-base> <hex-key> [json]",
  );
  process.exit(2);
}
const key = Uint8Array.from(
  hexKey.match(/.{2}/g).map((b) => Number.parseInt(b, 16)),
);
const wsUrl = base.replace(/^http/, "ws");
const now = () => Math.floor(Date.now() / 1000);

/** One authenticated WebSocket session: AUTH, then `send` once, resolving on `done`. */
function session(onOpen, onMessage) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let authed = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out"));
    }, 15_000);
    const finish = (value) => {
      clearTimeout(timer);
      ws.close();
      resolve(value);
    };
    ws.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (data[0] === "AUTH") {
        const auth = finalizeEvent(
          {
            kind: 22242,
            created_at: now(),
            tags: [
              ["relay", wsUrl],
              ["challenge", String(data[1])],
            ],
            content: "",
          },
          key,
        );
        ws.send(JSON.stringify(["AUTH", auth]));
        return;
      }
      if (!authed && data[0] === "OK") {
        authed = true;
        if (!data[2]) return finish({ error: `auth refused: ${data[3]}` });
        onOpen(ws);
        return;
      }
      onMessage(data, finish);
    });
    ws.addEventListener("error", () =>
      reject(new Error(`cannot reach ${wsUrl}`)),
    );
  });
}

function publish(event) {
  return session(
    (ws) => ws.send(JSON.stringify(["EVENT", event])),
    (data, finish) => {
      if (data[0] === "OK" && data[1] === event.id)
        finish({ accepted: data[2], reason: data[3] ?? "" });
    },
  );
}

function read(filter) {
  const found = [];
  return session(
    (ws) => ws.send(JSON.stringify(["REQ", "check", filter])),
    (data, finish) => {
      if (data[0] === "EVENT") found.push(data[2]);
      if (data[0] === "EOSE" || data[0] === "CLOSED") finish(found);
    },
  );
}

function blossomAuth(verb, sha256) {
  const signed = finalizeEvent(
    {
      kind: 24242,
      created_at: now(),
      tags: [
        ["t", verb],
        ["expiration", String(now() + 600)],
        ["server", new URL(base).host],
        ["x", sha256],
      ],
      content: `backup test ${verb}`,
    },
    key,
  );
  return `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`;
}

// A 1x1 PNG with one random pixel, so every run uploads a new file.
function png() {
  const pixel = Buffer.from(
    [Math.random() * 255, Math.random() * 255, Math.random() * 255].map(
      Math.floor,
    ),
  );
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const { deflateSync } = process.getBuiltinModule("node:zlib");
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat([Buffer.from([0]), pixel]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function getBlob(sha256) {
  let response = await fetch(`${base}/media/${sha256}`);
  if (response.status === 401 || response.status === 403) {
    response = await fetch(`${base}/media/${sha256}`, {
      headers: { Authorization: blossomAuth("get", sha256) },
    });
  }
  if (!response.ok) return null;
  return {
    sha256: createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex"),
    type: response.headers.get("content-type"),
  };
}

if (mode === "seed") {
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: now(),
      tags: [],
      content: `Backup test ${new Date().toISOString()} ${Math.random()}`,
    },
    key,
  );
  const result = await publish(event);
  if (!result.accepted) {
    console.error(`the post was refused: ${result.reason ?? result.error}`);
    process.exit(1);
  }
  const image = png();
  const sha256 = createHash("sha256").update(image).digest("hex");
  const upload = await fetch(`${base}/upload`, {
    method: "PUT",
    headers: {
      Authorization: blossomAuth("upload", sha256),
      "X-SHA-256": sha256,
      "Content-Type": "image/png",
    },
    body: image,
  });
  if (!upload.ok) {
    console.error(
      `the upload was refused (${upload.status}): ${await upload.text()}`,
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({ event: event.id, content: event.content, sha256 }),
  );
} else if (mode === "check" || mode === "absent") {
  const want = JSON.parse(saved ?? "{}");
  const events = await read({ kinds: [1], ids: [want.event] });
  const post = Array.isArray(events)
    ? events.find((e) => e.id === want.event)
    : undefined;
  const blob = await getBlob(want.sha256);
  if (mode === "check") {
    const problems = [];
    if (!post || post.content !== want.content)
      problems.push("the post is missing or changed");
    if (!blob || blob.sha256 !== want.sha256)
      problems.push("the image is missing or changed");
    else if (blob.type !== "image/png")
      problems.push(`the image is served as ${blob.type}`);
    if (problems.length > 0) {
      console.error(problems.join("; "));
      process.exit(1);
    }
    console.log("the post and the image are there, unchanged");
  } else {
    if (post || blob) {
      console.error(
        `still there: ${[post && "the post", blob && "the image"].filter(Boolean).join(" and ")}`,
      );
      process.exit(1);
    }
    console.log("neither the post nor the image is there");
  }
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
