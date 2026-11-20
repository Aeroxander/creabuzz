/**
 * The strict reading helpers every part of a record's parser uses: a value is the right kind of thing and inside its
 * bounds, or `Unreadable` is thrown. Nothing here falls back to a default number. `numbers-read.ts` (the whole body) and
 * `numbers-read-tasks.ts` (the task queue) both read through them.
 */

/** A value the record carried that cannot be believed: thrown inside the parser, turned into null at its edge. */
class Unreadable extends Error {}

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9]\d{0,38})$/;
/** The most any amount can be: 2^128. Far beyond any dollar or Share count the contracts allow. */
const AMOUNT_LIMIT = 1n << 128n;
/** The latest time the record may name: far past any real clock, short of anything that overflows. */
export const TIME_LIMIT = 2 ** 40;
export const COUNT_LIMIT = 1_000_000_000;

export function fail(path: string): never {
  throw new Unreadable(path);
}

export function obj(v: unknown, path: string): Json {
  return isObject(v) ? v : fail(path);
}
export function arr(v: unknown, path: string, max: number): unknown[] {
  return Array.isArray(v) && v.length <= max ? v : fail(path);
}
export function bool(v: unknown, path: string): boolean {
  return typeof v === "boolean" ? v : fail(path);
}
export function amount(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v)) return fail(path);
  const n = BigInt(v);
  return n < AMOUNT_LIMIT ? n : fail(path);
}
export function whole(v: unknown, path: string, max: number): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max
    ? v
    : fail(path);
}
export const time = (v: unknown, path: string) => whole(v, path, TIME_LIMIT);
export const count = (v: unknown, path: string) => whole(v, path, COUNT_LIMIT);
export function timeOrNull(v: unknown, path: string): number | null {
  return v === null ? null : time(v, path);
}
export function address(v: unknown, path: string): string {
  return typeof v === "string" && ADDRESS.test(v) ? v : fail(path);
}
export function addressOrNull(v: unknown, path: string): string | null {
  return v === null ? null : address(v, path);
}
export function bytes32(v: unknown, path: string): string {
  return typeof v === "string" && BYTES32.test(v) ? v : fail(path);
}
export function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  path: string,
): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fail(path);
}
