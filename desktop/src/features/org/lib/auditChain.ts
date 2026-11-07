/**
 * Client-side port of the relay's audit hash chain — byte-exact with
 * `crates/buzz-audit`. Every structural change the relay records lands in the
 * per-community `audit_log` chain; this module recomputes the same digests the
 * Rust crate writes, so the desktop can verify a loaded chain prefix on its
 * own instead of trusting a server-side green check.
 *
 * Rust sources this mirrors (line numbers are the citation, kept in sync by
 * `auditChain.test.mjs`, which parses the crate and fails if the construction
 * drifts):
 *
 * - `compute_hash` field order — `crates/buzz-audit/src/hash.rs:42-73`
 *   (`community_id` leads so an entry cannot be replayed across tenants).
 * - `to_storage_precision` (microsecond truncation) — `hash.rs:22-24`.
 * - `canonical_json` (sorted keys, serde string/number rendering) — `hash.rs:80-116`.
 * - `GENESIS_HASH` (32 zero bytes hashed for `prev_hash = NULL`) — `hash.rs:9`.
 * - `verify_chain` (prev-hash link, then recompute-and-compare, first loaded
 *   row is the anchor) — `crates/buzz-audit/src/service.rs:169-215`.
 * - `AuditEntry` fields — `crates/buzz-audit/src/entry.rs:14-37`.
 * - `AuditAction::as_str` — `crates/buzz-audit/src/action.rs:35-49`.
 *
 * Digests are pinned by vectors derived from the crate's own `compute_hash`
 * (see `auditChain.test.mjs` for the fixtures and their derivation).
 *
 * What a verified chain proves — and what it does not. The relay records every
 * structural moment in `audit_log` and publishes each entry as a relay-signed
 * kind:48001 event (`crates/buzz-relay/src/audit.rs`), readable by community
 * owners and admins only. Verifying the chain proves the entries the relay
 * published are INTERNALLY CONSISTENT: each links to its predecessor and each
 * digest matches its fields, so an entry edited or dropped from the middle of
 * a served run shows up as a break at that seq. It is NOT tamper-evidence
 * against the relay operator: the operator holds the signing key and the
 * database and can recompute a consistent chain from any point (or serve a
 * shorter one), and no external anchor pins the head. Treat it as a
 * consistency check on what the relay chooses to show, not as an independent
 * witness.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// The event kind (48001, `KIND_AUDIT_ENTRY`) is the shared constant in
// `@/shared/constants/kinds`; the relay publishes it, and serves it to owners
// and admins only, so a reader outside those roles sees an empty chain.

/** `hash.rs:9` — hashed in place of a missing `prev_hash` (chain genesis). */
export const GENESIS_HEX = "0".repeat(64);

/**
 * Preimage fields, in the crate's fixed order (`hash.rs:44-71`). The Rust
 * source-binding test maps every `hasher.update(...)` in `compute_hash` onto
 * this list, so reordering or adding a field in Rust reds the TS test suite.
 */
export const CHAIN_PREIMAGE_ORDER = [
  "community_id",
  "seq",
  "created_at",
  "action",
  "actor_pubkey",
  "object_id",
  "detail",
  "prev_hash",
] as const;

/** Why verification stopped. Mirrors `AuditError` (`error.rs`). */
export type ChainBreakReason =
  /** `AuditError::ChainViolation` — prev_hash ≠ preceding entry's hash. */
  | "chain_violation"
  /** `AuditError::HashMismatch` — recomputed digest ≠ stored hash. */
  | "hash_mismatch"
  /** Envelope could not be digested (bad uuid/hex/timestamp/JSON). */
  | "malformed";

export type ChainVerification = {
  /** `empty` — nothing loaded; `verified` — whole loaded run digests; `broken`. */
  state: "empty" | "verified" | "broken";
  /** First entry of the contiguous loaded run (seq), `null` when empty. */
  fromSeq: number | null;
  /** Last entry verified in that run — the coverage claim, `null` when empty. */
  toSeq: number | null;
  /** How many entries re-digested successfully. */
  count: number;
  /** True only when the run starts at seq 1 — a full chain, not a prefix. */
  genesis: boolean;
  /** Seq of the failing entry when `state === "broken"`. */
  breakSeq?: number;
  breakReason?: ChainBreakReason;
  /** First seq after a discontinuity in the loaded run (page boundary). */
  gapAtSeq?: number;
};

/**
 * A parsed `AuditEntry` (`entry.rs:14-37`) as read from a kind:48001 envelope.
 * `detail` keeps number lexemes (see `RustNumber`) so re-serialization matches
 * serde_json byte-for-byte.
 */
export type AuditChainEntry = {
  communityId: string;
  seq: number;
  /** SHA-256 of the entry, lowercase hex (32 bytes). */
  hash: string;
  prevHash: string | null;
  /** `AuditAction::as_str()` value, e.g. `"event_created"`. */
  action: string;
  /** Hex of the raw pubkey bytes; `""` = `Some(empty)`, `null` = `None`. */
  actorPubkey: string | null;
  objectId: string | null;
  detail: JsonValue;
  /** RFC 3339; normalized to storage precision before hashing. */
  createdAt: string;
  /** `entry.rs:20` — hash encoding: 1 = legacy concatenation, 2 = TLV. */
  hashVersion: number;
};

export type JsonValue =
  | null
  | boolean
  | string
  | RustNumber
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON number carrying its original lexeme (serde_json keeps `1.0` ≠ `1`). */
export class RustNumber {
  readonly lexeme: string;

  constructor(lexeme: string) {
    this.lexeme = lexeme;
  }
}

/** Raised for inputs that cannot be digested — never a silent wrong hash. */
export class AuditChainInputError extends Error {}

// ── JSON parsing that preserves number lexemes ──────────────────────────────

/**
 * Parse JSON exactly as `serde_json` would see it, except numbers keep their
 * lexeme: `JSON.parse("1.0")` collapses to `1`, and serde_json would then
 * print `1.0` while JS prints `1` — a different preimage and a false break.
 */
export function parseJson(raw: string): JsonValue {
  let index = 0;

  const fail = (message: string): never => {
    throw new AuditChainInputError(`${message} at offset ${index}`);
  };

  const skipWhitespace = () => {
    // serde_json accepts only these four bytes as whitespace.
    while (index < raw.length && " \t\n\r".includes(raw[index] as string)) {
      index += 1;
    }
  };

  const parseString = (): string => {
    index += 1; // opening quote
    let out = "";
    while (index < raw.length) {
      const ch = raw[index] as string;
      if (ch === '"') {
        index += 1;
        return out;
      }
      if (ch !== "\\") {
        out += ch;
        index += 1;
        continue;
      }
      index += 1;
      const esc = raw[index];
      index += 1;
      switch (esc) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = raw.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad unicode escape");
          index += 4;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          break;
        }
        default:
          return fail(`bad escape \\${esc}`);
      }
    }
    return fail("unterminated string");
  };

  const parseNumber = (): RustNumber => {
    const start = index;
    if (raw[index] === "-") index += 1;
    if (raw[index] === "0") {
      index += 1;
    } else if (/[1-9]/.test(raw[index] ?? "")) {
      while (/[0-9]/.test(raw[index] ?? "")) index += 1;
    } else {
      return fail("bad number");
    }
    if (raw[index] === ".") {
      index += 1;
      if (!/[0-9]/.test(raw[index] ?? "")) return fail("bad fraction");
      while (/[0-9]/.test(raw[index] ?? "")) index += 1;
    }
    if (raw[index] === "e" || raw[index] === "E") {
      index += 1;
      if (raw[index] === "+" || raw[index] === "-") index += 1;
      if (!/[0-9]/.test(raw[index] ?? "")) return fail("bad exponent");
      while (/[0-9]/.test(raw[index] ?? "")) index += 1;
    }
    return new RustNumber(raw.slice(start, index));
  };

  const parseValue = (): JsonValue => {
    skipWhitespace();
    const ch = raw[index];
    if (ch === undefined) return fail("unexpected end of input");
    if (ch === "{") {
      index += 1;
      const obj: { [key: string]: JsonValue } = {};
      skipWhitespace();
      if (raw[index] === "}") {
        index += 1;
        return obj;
      }
      for (;;) {
        skipWhitespace();
        if (raw[index] !== '"') return fail("expected object key");
        const key = parseString();
        skipWhitespace();
        if (raw[index] !== ":") return fail("expected ':'");
        index += 1;
        obj[key] = parseValue();
        skipWhitespace();
        if (raw[index] === ",") {
          index += 1;
          continue;
        }
        if (raw[index] === "}") {
          index += 1;
          return obj;
        }
        return fail("expected ',' or '}'");
      }
    }
    if (ch === "[") {
      index += 1;
      const arr: JsonValue[] = [];
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skipWhitespace();
        if (raw[index] === ",") {
          index += 1;
          continue;
        }
        if (raw[index] === "]") {
          index += 1;
          return arr;
        }
        return fail("expected ',' or ']'");
      }
    }
    if (ch === '"') return parseString();
    if (raw.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (raw.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (raw.startsWith("null", index)) {
      index += 4;
      return null;
    }
    if (ch === "-" || /[0-9]/.test(ch)) return parseNumber();
    return fail(`unexpected character ${ch}`);
  };

  const value = parseValue();
  skipWhitespace();
  if (index !== raw.length) fail("trailing characters");
  return value;
}

// ── serde_json-compatible rendering ─────────────────────────────────────────

const UTF8 = new TextEncoder();

/** Byte-wise key order — `BTreeMap<&str, …>` in `canonical_json` (`hash.rs:86`). */
function compareUtf8(a: string, b: string): number {
  const left = UTF8.encode(a);
  const right = UTF8.encode(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const diff = (left[i] as number) - (right[i] as number);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * serde_json / ryu rendering of a JSON number from its lexeme.
 * Integers inside `i64..u64` print exactly as written (serde keeps them
 * integral, so `9007199254740993` survives where `Number` would not); every
 * other lexeme becomes an f64 rendered in ryu's shortest form: plain decimal
 * for decimal exponent −5..=15 with a trailing `.0`, else `1.23e+16` style.
 * Pinned against the crate for 42 lexemes in `auditChain.test.mjs`.
 */
function rustNumberText(lexeme: string): string {
  if (/^-?\d+$/.test(lexeme)) {
    const asInt = BigInt(lexeme);
    // serde_json parses `-0` as f64 −0.0 (it round-trips the sign), every
    // other in-range integer stays i64/u64.
    if (asInt !== 0n || lexeme === "0") {
      const i64Min = -(2n ** 63n);
      const u64Max = 2n ** 64n - 1n;
      if (asInt >= i64Min && asInt <= u64Max) return asInt.toString();
    }
  }
  const value = Number(lexeme);
  if (!Number.isFinite(value)) {
    throw new AuditChainInputError(`non-finite number ${lexeme}`);
  }
  if (Object.is(value, -0)) return "-0.0";
  if (value === 0) return "0.0";
  const [signedMantissa, exponentText] = value.toExponential().split("e") as [
    string,
    string,
  ];
  const negative = signedMantissa.startsWith("-");
  const mantissa = negative ? signedMantissa.slice(1) : signedMantissa;
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  const magnitude =
    exponent >= -5 && exponent <= 15
      ? exponent >= digits.length - 1
        ? `${digits}${"0".repeat(exponent - digits.length + 1)}.0`
        : exponent >= 0
          ? `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`
          : `0.${"0".repeat(-exponent - 1)}${digits}`
      : `${digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`}e${
          exponent >= 0 ? "+" : ""
        }${exponent}`;
  return negative ? `-${magnitude}` : magnitude;
}

/**
 * `canonical_json` (`hash.rs:80-116`): objects with keys sorted by UTF-8
 * bytes, arrays in order, scalars in serde_json's own notation. Strings use
 * JSON escaping, which matches serde_json for every valid input (control
 * characters short-escaped, `\u00xx` lowercase, no `/` or non-ASCII escaping).
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof RustNumber) return rustNumberText(value.lexeme);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AuditChainInputError(`non-finite number ${value}`);
    }
    // Convenience path for callers holding plain JS values: the lexeme is
    // reconstructed from the shortest round-trip form, which matches serde_json
    // for every value except a float that JS prints integral (e.g. `1.0`).
    // Envelopes go through `parseJson`, which keeps the real lexeme.
    return rustNumberText(String(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareUtf8);
  const body = keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    )
    .join(",");
  return `{${body}}`;
}

// ── Timestamps ──────────────────────────────────────────────────────────────

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * `to_storage_precision` + `DateTime::to_rfc3339()` (`hash.rs:22-24`, `48-51`):
 * truncate to microseconds, render in UTC with chrono's `AutoSi` fractional
 * width (0, 3 or 6 digits — nanoseconds can never round-trip through Postgres)
 * and the `+00:00` offset `to_rfc3339` always emits.
 */
export function storagePrecisionRfc3339(input: string): string {
  const match = TIMESTAMP.exec(input.trim());
  if (!match) {
    throw new AuditChainInputError(`unrecognized timestamp ${input}`);
  }
  const [, year, month, day, hour, minute, second, fraction, offset] = match;
  const fractionDigits = (fraction ?? "").slice(1);
  const nanos = Number(`${fractionDigits.padEnd(9, "0").slice(0, 9)}`);
  const offsetShiftMs = (() => {
    if (offset === "Z" || offset === "z") return 0;
    const sign = (offset as string).startsWith("-") ? -1 : 1;
    const offsetHour = Number((offset as string).slice(1, 3));
    const offsetMinute = Number((offset as string).slice(4, 6));
    return sign * (offsetHour * 60 + offsetMinute) * 60_000;
  })();
  const utcMs =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      0,
    ) - offsetShiftMs;
  const date = new Date(utcMs);
  if (Number.isNaN(date.getTime())) {
    throw new AuditChainInputError(`unrecognized timestamp ${input}`);
  }
  // trunc_subsecs(6): keep whole microseconds, drop the rest.
  const micros = Math.floor(nanos / 1_000);
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");
  let subSecond = "";
  if (micros !== 0) {
    // chrono `SecondsFormat::AutoSi`: 3 digits when the value is whole
    // milliseconds, otherwise 6 — trailing zeros inside that width stay.
    subSecond =
      micros % 1_000 === 0
        ? `.${pad(micros / 1_000, 3)}`
        : `.${pad(micros, 6)}`;
  }
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
    `${subSecond}+00:00`
  );
}

// ── Hashing ─────────────────────────────────────────────────────────────────

function uuidBytes(uuid: string): Uint8Array {
  const compact = uuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new AuditChainInputError(`invalid community id ${uuid}`);
  }
  return hexToBytes(compact);
}

function seqBytes(seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq)) {
    throw new AuditChainInputError(`invalid seq ${seq}`);
  }
  const out = new Uint8Array(8);
  let value = BigInt.asUintN(64, BigInt(seq));
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function hexOrEmptyBytes(hex: string): Uint8Array {
  if (hex === "") return new Uint8Array(0);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new AuditChainInputError(`invalid hex ${hex}`);
  }
  return hexToBytes(hex);
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * SHA-256 over the entry's fields using its stored encoding version
 * (`hash.rs:34-39` dispatch). Returns lowercase hex. A `hash_version` the
 * crate does not know cannot be digested — throwing here is the honest
 * answer, never a guess at the preimage.
 */
export function computeChainHash(entry: AuditChainEntry): string {
  switch (entry.hashVersion) {
    case 1:
      return computeLegacyChainHash(entry);
    case 2:
      return computeTlvChainHash(entry);
    default:
      throw new AuditChainInputError(
        `unsupported hash_version ${entry.hashVersion}`,
      );
  }
}

/**
 * Version 2 (current) — SHA-256 over the TLV encoding (`hash.rs:41-77`
 * `compute_tlv_hash`): the domain `"buzz:audit:v2"` NUL-terminated, then each
 * field as a one-byte tag, a big-endian u64 byte length, and the value, in
 * tag order (1 community, 2 seq, 3 created_at, 4 action, 5 actor_pubkey,
 * 6 object_id, 7 detail, 8 prev_hash). Absent optional fields are OMITTED
 * entirely while present-but-empty values keep their tag at zero length —
 * this is where v2 removes the v1 preimage ambiguity. Note `prev_hash` is
 * omitted for a chain's first entry (v1 substituted `GENESIS_HASH`).
 */
function computeTlvChainHash(entry: AuditChainEntry): string {
  const parts: Uint8Array[] = [
    UTF8.encode("buzz:audit:v2\u0000"),
    tlvField(1, uuidBytes(entry.communityId)),
    tlvField(2, seqBytes(entry.seq)),
    tlvField(3, UTF8.encode(storagePrecisionRfc3339(entry.createdAt))),
    tlvField(4, UTF8.encode(entry.action)),
  ];
  if (entry.actorPubkey !== null) {
    parts.push(tlvField(5, hexOrEmptyBytes(entry.actorPubkey)));
  }
  if (entry.objectId !== null) {
    parts.push(tlvField(6, UTF8.encode(entry.objectId)));
  }
  parts.push(tlvField(7, UTF8.encode(canonicalJson(entry.detail))));
  if (entry.prevHash !== null) {
    parts.push(tlvField(8, hexOrEmptyBytes(entry.prevHash)));
  }
  return bytesToHex(sha256(concatBytes(parts)));
}

/** One TLV field: tag byte, big-endian u64 length, value (`hash.rs:79-83`). */
function tlvField(tag: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 8 + value.length);
  out[0] = tag;
  new DataView(out.buffer).setBigUint64(1, BigInt(value.length), false);
  out.set(value, 9);
  return out;
}

/**
 * Version 1 (historical rows only) — SHA-256 over the entry's identity, chain,
 * and context fields, in the crate's fixed order (`hash.rs:85-…`
 * `compute_legacy_hash`). Preserved byte-for-byte: historical digests must
 * keep verifying.
 */
function computeLegacyChainHash(entry: AuditChainEntry): string {
  const actor =
    entry.actorPubkey === null
      ? new Uint8Array([0])
      : concatBytes([new Uint8Array([1]), hexOrEmptyBytes(entry.actorPubkey)]);
  const object =
    entry.objectId === null
      ? new Uint8Array([0])
      : concatBytes([new Uint8Array([1]), UTF8.encode(entry.objectId)]);
  const prev =
    entry.prevHash === null
      ? hexToBytes(GENESIS_HEX)
      : hexOrEmptyBytes(entry.prevHash);
  const digest = sha256(
    concatBytes([
      uuidBytes(entry.communityId),
      seqBytes(entry.seq),
      UTF8.encode(storagePrecisionRfc3339(entry.createdAt)),
      UTF8.encode(entry.action),
      actor,
      object,
      UTF8.encode(canonicalJson(entry.detail)),
      prev,
    ]),
  );
  return bytesToHex(digest);
}

// ── Envelope parsing ────────────────────────────────────────────────────────

function bytesFieldToHex(value: JsonValue, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const bytes = value.map((part) => {
      if (
        !(part instanceof RustNumber) ||
        !/^\d+$/.test(part.lexeme) ||
        Number(part.lexeme) > 255
      ) {
        throw new AuditChainInputError(`${field} is not a byte array`);
      }
      return Number(part.lexeme);
    });
    return bytesToHex(Uint8Array.from(bytes));
  }
  if (typeof value === "string") {
    const compact = value.toLowerCase();
    if (compact === "") return "";
    if (!/^[0-9a-f]+$/.test(compact) || compact.length % 2 !== 0) {
      throw new AuditChainInputError(`${field} is not hex`);
    }
    return compact;
  }
  throw new AuditChainInputError(`${field} has unsupported type`);
}

function numberField(value: JsonValue, field: string): number {
  if (!(value instanceof RustNumber) || !/^-?\d+$/.test(value.lexeme)) {
    throw new AuditChainInputError(`${field} is not an integer`);
  }
  const parsed = Number(value.lexeme);
  if (!Number.isSafeInteger(parsed)) {
    throw new AuditChainInputError(`${field} is out of range`);
  }
  return parsed;
}

function stringField(value: JsonValue, field: string): string {
  if (typeof value !== "string") {
    throw new AuditChainInputError(`${field} is not a string`);
  }
  return value;
}

/**
 * Parse one kind:48001 envelope into an `AuditChainEntry`.
 *
 * The envelope is `AuditEntry`'s own serde shape (`entry.rs:13` derives
 * `Serialize`): `hash`, `prev_hash` and `actor_pubkey` arrive as byte arrays
 * (`Vec<u8>` → `[171, 171, …]`); a hex string is accepted too so any producer
 * that renders digests as hex interops. Returns `null` when the payload is not
 * an entry at all — malformed entries are dropped, never guessed at.
 */
export function parseChainEntry(content: string): AuditChainEntry | null {
  let parsed: JsonValue;
  try {
    parsed = parseJson(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as { [key: string]: JsonValue };
  try {
    if (
      record.community_id === undefined ||
      record.seq === undefined ||
      record.hash === undefined ||
      record.action === undefined ||
      record.created_at === undefined ||
      record.hash_version === undefined
    ) {
      return null;
    }
    const hash = bytesFieldToHex(record.hash, "hash");
    if (hash === null || hash.length !== 64) return null;
    const prevHash =
      record.prev_hash === undefined || record.prev_hash === null
        ? null
        : bytesFieldToHex(record.prev_hash, "prev_hash");
    if (prevHash !== null && prevHash.length !== 64) return null;
    return {
      communityId: stringField(record.community_id, "community_id"),
      seq: numberField(record.seq, "seq"),
      hash,
      prevHash,
      action: stringField(record.action, "action"),
      actorPubkey: bytesFieldToHex(record.actor_pubkey ?? null, "actor_pubkey"),
      objectId:
        record.object_id === undefined || record.object_id === null
          ? null
          : stringField(record.object_id, "object_id"),
      detail: record.detail ?? null,
      createdAt: stringField(record.created_at, "created_at"),
      hashVersion: numberField(record.hash_version, "hash_version"),
    };
  } catch {
    return null;
  }
}

/**
 * Parse a batch of envelopes, counting the ones that failed. A malformed
 * entry is reported, never dropped silently: verification over a partial set
 * would otherwise claim green coverage it does not have.
 */
export function parseChainEntryBatch(contents: ReadonlyArray<string>): {
  entries: AuditChainEntry[];
  malformed: number;
} {
  const entries: AuditChainEntry[] = [];
  let malformed = 0;
  for (const content of contents) {
    const entry = parseChainEntry(content);
    if (entry) entries.push(entry);
    else malformed += 1;
  }
  return { entries, malformed };
}

// ── Verification ────────────────────────────────────────────────────────────

/**
 * Verify a loaded run of chain entries, mirroring `AuditService::verify_chain`
 * (`service.rs:169-215`): each entry's `prev_hash` must equal the preceding
 * entry's hash, and each stored hash must equal its recomputed digest; the
 * first loaded entry is the anchor (its `prev_hash` is unchecked — exactly
 * what `expected_prev = None` does in Rust), so a bounded page proves its own
 * internal consistency, not the whole chain.
 *
 * The Rust query reads a contiguous `seq BETWEEN` range, so it never sees a
 * gap; a client page can. Verification therefore stops at the first seq jump
 * and reports `gapAtSeq` instead of reporting a false break.
 */
export function verifyChain(
  entries: ReadonlyArray<AuditChainEntry>,
): ChainVerification {
  if (entries.length === 0) {
    return {
      state: "empty",
      fromSeq: null,
      toSeq: null,
      count: 0,
      genesis: false,
    };
  }
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  let expectedPrev: string | null = null;
  let verified = 0;
  let toSeq: number | null = null;
  let fromSeq: number | null = null;

  const broken = (
    breakSeq: number,
    breakReason: ChainBreakReason,
  ): ChainVerification => ({
    state: "broken",
    fromSeq,
    toSeq,
    count: verified,
    genesis: fromSeq === 1,
    breakSeq,
    breakReason,
  });

  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i] as AuditChainEntry;
    const previous = sorted[i - 1] as AuditChainEntry | undefined;
    if (previous) {
      if (entry.seq === previous.seq) return broken(entry.seq, "malformed");
      if (entry.seq !== previous.seq + 1) {
        // Page discontinuity, not a chain break: stop coverage here instead
        // of reporting a break the relay never wrote.
        return {
          state: verified > 0 ? "verified" : "empty",
          fromSeq,
          toSeq,
          count: verified,
          genesis: fromSeq === 1,
          gapAtSeq: entry.seq,
        };
      }
    }
    if (expectedPrev !== null && entry.prevHash !== expectedPrev) {
      return broken(entry.seq, "chain_violation");
    }
    let computed: string;
    try {
      computed = computeChainHash(entry);
    } catch {
      return broken(entry.seq, "malformed");
    }
    if (computed !== entry.hash) return broken(entry.seq, "hash_mismatch");
    if (fromSeq === null) fromSeq = entry.seq;
    toSeq = entry.seq;
    verified += 1;
    expectedPrev = entry.hash;
  }

  return {
    state: "verified",
    fromSeq,
    toSeq,
    count: verified,
    genesis: fromSeq === 1,
  };
}

// ── Per-row badges ──────────────────────────────────────────────────────────

export type ChainBadge =
  /** Entry digests and links correctly — chain position shown. */
  | { state: "verified"; seq: number; action: string }
  /** This entry IS the break: recomputed digest or link disagrees. */
  | {
      state: "broken";
      seq: number;
      action: string;
      reason: ChainBreakReason;
    }
  /** Chain loaded but this entry sits after the break or page gap. */
  | { state: "unverified"; seq: number; action: string }
  /** Chain loaded, nothing in it covers this event. */
  | { state: "not-in-chain" }
  /** The relay served no chain entries — verification not available. */
  | { state: "unavailable" };

/**
 * Map a verification result onto the events the timeline shows. Chain entries
 * carry the event they recorded in `object_id` (`handlers/event.rs:592` writes
 * the stored event id there for `event_created`), which is the join key.
 */
export function deriveChainBadges(
  entries: ReadonlyArray<AuditChainEntry>,
  verification: ChainVerification,
): Map<string, ChainBadge> {
  const badges = new Map<string, ChainBadge>();
  if (entries.length === 0 || verification.state === "empty") {
    return badges;
  }
  for (const entry of entries) {
    if (entry.objectId === null) continue;
    let badge: ChainBadge;
    if (verification.state === "broken") {
      const breakSeq = verification.breakSeq as number;
      if (entry.seq < breakSeq) {
        badge = { state: "verified", seq: entry.seq, action: entry.action };
      } else if (entry.seq === breakSeq) {
        badge = {
          state: "broken",
          seq: entry.seq,
          action: entry.action,
          reason: verification.breakReason as ChainBreakReason,
        };
      } else {
        badge = { state: "unverified", seq: entry.seq, action: entry.action };
      }
    } else if (
      verification.toSeq !== null &&
      entry.seq <= verification.toSeq &&
      (verification.fromSeq === null || entry.seq >= verification.fromSeq)
    ) {
      badge = { state: "verified", seq: entry.seq, action: entry.action };
    } else {
      badge = { state: "unverified", seq: entry.seq, action: entry.action };
    }
    if (!badges.has(entry.objectId)) badges.set(entry.objectId, badge);
  }
  return badges;
}

/** Badge for one timeline row; rows outside a served chain read `unavailable`. */
export function badgeForEvent(
  badges: ReadonlyMap<string, ChainBadge>,
  eventId: string,
  chainServed: boolean,
): ChainBadge {
  if (!chainServed) return { state: "unavailable" };
  return badges.get(eventId) ?? { state: "not-in-chain" };
}

// ── Labels ──────────────────────────────────────────────────────────────────

/**
 * One name per action (`action.rs:35-49` is the closed set). Unknown actions
 * are shown as unknown — a future action must never render as if it were an
 * existing one.
 */
export function auditActionLabel(action: string): string {
  switch (action) {
    case "event_created":
      return "Event created";
    case "event_deleted":
      return "Event deleted";
    case "channel_created":
      return "Channel created";
    case "channel_updated":
      return "Channel updated";
    case "channel_deleted":
      return "Channel deleted";
    case "member_added":
      return "Member added";
    case "member_removed":
      return "Member removed";
    case "auth_success":
      return "Sign-in succeeded";
    case "auth_failure":
      return "Sign-in failed";
    case "rate_limit_exceeded":
      return "Rate limit exceeded";
    case "media_uploaded":
      return "Media uploaded";
    default:
      return `Unknown action (${action})`;
  }
}
