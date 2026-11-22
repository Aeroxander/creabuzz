/**
 * Git packs made by hand for tests of the brain reader: a pack is "PACK", a version, a count, each object as a short header
 * and its deflated bytes, and the SHA-1 of all that. Nothing here is the app's code; it builds what a (possibly hostile)
 * server would send, so the reader's limits can be driven through the real git library.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const TYPE = { commit: 1, tree: 2, blob: 3, ofsDelta: 6 } as const;

/** One object of a pack: its type, the length it STATES, and the bytes that are deflated (what it really holds). */
export interface PackEntry {
  type: number;
  /** The length the pack states for the object (a lying pack states less than the bytes unpack to). */
  stated: number;
  /** The deflated stream (already compressed). */
  deflated: Uint8Array;
  /** For a delta based on an earlier object of the pack: how far back its start is (bytes). */
  backBy?: number;
}

function header(type: number, length: number): number[] {
  const bytes: number[] = [];
  let rest = length >>> 4;
  bytes.push((type << 4) | (length & 0b1111) | (rest > 0 ? 0x80 : 0));
  while (rest > 0) {
    const low = rest & 0x7f;
    rest >>>= 7;
    bytes.push(low | (rest > 0 ? 0x80 : 0));
  }
  return bytes;
}

function backOffset(distance: number): number[] {
  let rest = distance;
  const bytes = [rest & 0x7f];
  rest >>>= 7;
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest & 0x7f));
    rest >>>= 7;
  }
  return bytes;
}

function entryBytes(entry: PackEntry): Uint8Array {
  const head = header(entry.type, entry.stated);
  if (entry.backBy !== undefined) head.push(...backOffset(entry.backBy));
  const out = new Uint8Array(head.length + entry.deflated.length);
  out.set(head, 0);
  out.set(entry.deflated, head.length);
  return out;
}

/** The bytes of a pack holding `entries`, in order. */
export function makePack(entries: PackEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const top = new Uint8Array(12);
  top.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(top.buffer).setUint32(8, entries.length);
  parts.push(top);
  for (const entry of entries) parts.push(entryBytes(entry));
  const body = concat(parts);
  const sum = createHash("sha1").update(body).digest();
  return concat([body, sum]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An honest, undeltified object: its stated length is its real length. */
export function plainEntry(
  type: keyof typeof TYPE,
  content: Uint8Array,
): PackEntry {
  return {
    type: TYPE[type],
    stated: content.length,
    deflated: deflateSync(content),
  };
}

/** The git object id of `content` as a `type` object. */
export function objectId(type: string, content: Uint8Array): string {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${content.length}\0`))
    .update(content)
    .digest("hex");
}

/** A small repository holding `files` (name to text) at the top and `playbooks`, as the objects of a pack and the commit id. */
export function makeBrainPack(
  files: Record<string, string>,
  playbooks: Record<string, string>,
): { pack: Uint8Array; commit: string } {
  const entries: PackEntry[] = [];
  const text = (s: string) => new TextEncoder().encode(s);
  const tree = (items: { mode: string; name: string; id: string }[]) => {
    const sorted = [...items].sort((a, b) => (a.name < b.name ? -1 : 1));
    const body = concat(
      sorted.map((i) =>
        concat([text(`${i.mode} ${i.name}\0`), Buffer.from(i.id, "hex")]),
      ),
    );
    entries.push(plainEntry("tree", body));
    return objectId("tree", body);
  };
  const blobs = (named: Record<string, string>) =>
    Object.entries(named).map(([name, content]) => {
      const bytes = text(content);
      entries.push(plainEntry("blob", bytes));
      return { mode: "100644", name, id: objectId("blob", bytes) };
    });
  const inner = tree(blobs(playbooks));
  const top = blobs(files);
  const root = tree([...top, { mode: "40000", name: "playbooks", id: inner }]);
  const commitBody = text(
    `tree ${root}\nauthor T <t@example.invalid> 1700000000 +0000\ncommitter T <t@example.invalid> 1700000000 +0000\n\nnotes\n`,
  );
  entries.push(plainEntry("commit", commitBody));
  return {
    pack: makePack(entries),
    commit: objectId("commit", commitBody),
  };
}

function pkt(line: Uint8Array | string): Uint8Array {
  const body = typeof line === "string" ? new TextEncoder().encode(line) : line;
  return concat([
    new TextEncoder().encode((body.length + 4).toString(16).padStart(4, "0")),
    body,
  ]);
}

const FLUSH = new TextEncoder().encode("0000");

/** What a git server answers to the list of branches (protocol 1, the one a plain smart-HTTP server speaks). */
export function advertisement(commit: string): Uint8Array {
  const caps =
    "multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress symref=HEAD:refs/heads/main agent=test";
  return concat([
    pkt("# service=git-upload-pack\n"),
    FLUSH,
    pkt(`${commit} HEAD\0${caps}\n`),
    pkt(`${commit} refs/heads/main\n`),
    FLUSH,
  ]);
}

/** What a git server answers to a request for the newest commit: no common history, then the pack on the data channel. */
export function uploadReply(pack: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [pkt("NAK\n")];
  for (let at = 0; at < pack.length; at += 60_000) {
    parts.push(
      pkt(concat([new Uint8Array([1]), pack.subarray(at, at + 60_000)])),
    );
  }
  parts.push(FLUSH);
  return parts;
}

/** `bytes` of zeros, deflated: about a thousand times smaller than it unpacks to. */
export function deflatedZeros(bytes: number): Uint8Array {
  return deflateSync(Buffer.alloc(bytes), { level: 9 });
}

/**
 * A delta (as stored in a pack, before it is deflated) that says its target is `targetSize` bytes and builds it from
 * `copies` copies of the first `copySize` bytes of the base.
 */
export function copyDelta(
  baseSize: number,
  targetSize: number,
  copies: number,
  copySize: number,
): Uint8Array {
  const varint = (n: number) => {
    const bytes: number[] = [];
    let rest = n;
    do {
      const low = rest & 0x7f;
      rest = Math.floor(rest / 128);
      bytes.push(low | (rest > 0 ? 0x80 : 0));
    } while (rest > 0);
    return bytes;
  };
  const op = [0xb0, copySize & 0xff, (copySize >> 8) & 0xff];
  const bytes = [...varint(baseSize), ...varint(targetSize)];
  for (let i = 0; i < copies; i++) bytes.push(...op);
  return new Uint8Array(bytes);
}

export { deflateSync };
