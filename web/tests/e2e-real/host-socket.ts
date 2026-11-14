import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";

/**
 * A WebSocket to the relay, opened from Node against a community's own host.
 *
 * The relay routes by the `Host` header, and a self-serve community lives at
 * `<name>.localhost:<port>` (`scripts/web-economy-e2e.sh`). Chromium sends every
 * `*.localhost` name to loopback on its own; the operating system's resolver
 * does not, so Node cannot resolve that name at all.
 *
 * Node's global `WebSocket` (undici) cannot help: it takes no `headers` option
 * here (a `Host` header passed that way is dropped), so it would talk to the
 * relay under whatever host the socket connected to. This client therefore does
 * the one thing the browser does: dial loopback, and say which community it
 * wants in the `Host` header. Nothing else about the read changes — same
 * challenge, same signed AUTH, same REQ.
 *
 * Deliberately small: the read path only needs text frames, ping/pong and
 * close, which is all RFC 6455 requires of a client here.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The callbacks a reader uses; `onmessage` gets whole text frames. */
export interface HostSocket {
  send(text: string): void;
  close(): void;
  onmessage: ((text: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

/**
 * Text frames that arrived before a reader was listening (the relay's AUTH
 * challenge can share the packet with the handshake response), kept until it is.
 */
class EarlyFrames {
  private readonly waiting: string[] = [];
  private handler: ((text: string) => void) | null = null;

  get reader() {
    return this.handler;
  }

  push(text: string) {
    if (this.handler) this.handler(text);
    else this.waiting.push(text);
  }

  set(next: ((text: string) => void) | null) {
    this.handler = next;
    if (!next) return;
    for (const text of this.waiting.splice(0)) next(text);
  }
}

/** The client half of the handshake, computed from the key we send. */
const acceptFor = (key: string) =>
  createHash("sha1")
    .update(key + GUID)
    .digest("base64");

/** One masked text frame (a client MUST mask; the relay MUST not). */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x81; // FIN, text
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1)
    masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** A control frame (close or pong): masked, under 126 bytes. */
function controlFrame(opcode: number, payload = Buffer.alloc(0)): Buffer {
  const mask = randomBytes(4);
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | payload.length;
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1)
    masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Split a host authority (`name.localhost:3199`) into the dial target and the header value. */
function authority(host: string): { dialPort: number; header: string } {
  const url = new URL(`ws://${host}`);
  if (!url.port)
    throw new Error(`the community host ${host} names no port to dial`);
  return { dialPort: Number(url.port), header: url.host };
}

/**
 * Open a WebSocket that presents `host` (the community's own host, e.g.
 * `e2e-abc.localhost:3199`) to the relay, while dialling loopback.
 */
export function connectToHost(host: string): Promise<HostSocket> {
  const { dialPort, header } = authority(host);
  const key = randomBytes(16).toString("base64");

  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let open = false;
    let closed = false;
    let buffer = Buffer.alloc(0);
    const fragments: Buffer[] = [];
    const early = new EarlyFrames();
    let errorReader: ((error: Error) => void) | null = null;
    let pendingError: Error | null = null;

    const client: HostSocket = {
      get onmessage() {
        return early.reader;
      },
      set onmessage(next) {
        early.set(next);
      },
      get onerror() {
        return errorReader;
      },
      set onerror(next) {
        errorReader = next;
        if (!next || !pendingError) return;
        const error = pendingError;
        pendingError = null;
        next(error);
      },
      send(text) {
        if (closed) return;
        socket?.write(textFrame(text));
      },
      close() {
        if (closed) return;
        closed = true;
        socket?.write(controlFrame(0x8));
        socket?.end();
        // The read is over: let the process exit even if the relay keeps its half open.
        socket?.unref();
      },
    };

    const fail = (error: Error) => {
      if (closed) return;
      closed = true;
      socket?.destroy();
      if (!open) reject(error);
      else if (errorReader) errorReader(error);
      else pendingError = error;
    };

    const drain = () => {
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        let mask: Buffer | null = null;
        if (masked) {
          if (buffer.length < offset + 4) return;
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < length; i += 1) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + length);

        if (opcode === 0x8) {
          // The server is closing: answer and stop.
          if (!closed) {
            closed = true;
            socket?.write(controlFrame(0x8, payload.subarray(0, 2)));
            socket?.end();
          }
          return;
        }
        if (opcode === 0x9) {
          socket?.write(controlFrame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) continue; // pong
        // Text (0x1) or a continuation (0x0) of one.
        fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString("utf8");
        fragments.length = 0;
        early.push(text);
      }
    };

    const req = request({
      host: "127.0.0.1",
      port: dialPort,
      path: "/",
      headers: {
        // What makes this the community's connection: the relay binds the
        // community from this header, and checks the NIP-42 `relay` tag against
        // it, exactly as it does for the browser's own socket.
        Host: header,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });

    req.on("upgrade", (response, upgraded, head) => {
      if (response.headers["sec-websocket-accept"] !== acceptFor(key)) {
        upgraded.destroy();
        fail(new Error(`the server at ${host} did not accept the handshake`));
        return;
      }
      socket = upgraded;
      open = true;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        drain();
      });
      socket.on("error", (error) => fail(error));
      socket.on("close", () => {
        closed = true;
      });
      if (head.length > 0) {
        buffer = Buffer.concat([buffer, head]);
        drain();
      }
      resolve(client);
    });
    req.on("response", (response) => {
      response.resume();
      fail(
        new Error(
          `the server answered ${String(response.statusCode)} at ${host} instead of upgrading`,
        ),
      );
    });
    req.on("error", (error) => fail(error));
    req.end();
  });
}
