/**
 * The one example file the server and the app both test against, read from disk (never retyped), and the small helpers
 * the record tests share: the example as the server would sign it, and parsed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type NumbersEvent,
  parseNumbers,
  type ProjectNumbers,
} from "../../src/features/money/numbers";
import { chainIdentityV2 } from "./numbers-v2-fixture";

export type Json = Record<string, unknown>;

export const EXAMPLE_PATH = resolve(
  __dirname,
  "../../../docs/next-version/record-v2-example.json",
);
export const raw = (): Json => JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));

export const SERVER = "f".repeat(64);
export const NOW = 1_800_000_000;
export const COORDINATE = `37001:${"b".repeat(64)}:demo`;
export const { key: KEY } = chainIdentityV2(COORDINATE);
export const EXAMPLE_KEY = (raw().key as string).toLowerCase();

export function event(content: unknown, overrides: Partial<NumbersEvent> = {}) {
  return {
    id: "1".repeat(64),
    pubkey: SERVER,
    kind: 39009,
    created_at: NOW,
    tags: [["d", KEY]],
    content: typeof content === "string" ? content : JSON.stringify(content),
    ...overrides,
  } satisfies NumbersEvent;
}

/** The example as the server would sign it for its own key (no project to check against). */
export function exampleEvent(content: unknown = raw()): NumbersEvent {
  return event(content, { tags: [["d", EXAMPLE_KEY]] });
}

export function parsedExample(): ProjectNumbers {
  const numbers = parseNumbers(exampleEvent(), SERVER);
  if (!numbers || numbers.removed) throw new Error("the example did not parse");
  return numbers;
}
