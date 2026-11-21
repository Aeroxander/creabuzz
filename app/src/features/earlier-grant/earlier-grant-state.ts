/**
 * The earlier backers' claim page, decided as a pure function of what it has read: the link in the address, the signed-in
 * account, the record's claim key, the build's own fingerprint and what the network says. The first thing wrong is the one said,
 * and a link that is not the account's is never told apart from one that is simply wrong: the page never says whose it is and never
 * shows a row that is not the signed-in account's. A row's link is made by whoever holds the list and is carried in the part of
 * the address after `#`, which a browser never sends to any server.
 */
import {
  type EarlierRow,
  verifyEarlierRow,
} from "@creaton/core/pot/earlier-proof.ts";

/** What a link carries: the row's place and amount and its proof. */
export interface EarlierLink {
  index: bigint;
  amount: bigint;
  proof: string[];
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9]\d{0,38})$/;
const MAX_PROOF = 32;
const MAX_FRAGMENT = 4_000;

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The row in a link's fragment (`#<base64url of {"index":"4","amount":"1000…","proof":["0x…"]}>`), or null when there is none or
 * it is not one: a link that cannot be read is the same as no link.
 */
export function readEarlierLink(fragment: string): EarlierLink | null {
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (text === "" || text.length > MAX_FRAGMENT) return null;
  const json = fromBase64Url(text);
  if (json === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { index, amount, proof } = body as Record<string, unknown>;
  const asNumber = (v: unknown) =>
    typeof v === "string" && DECIMAL.test(v)
      ? BigInt(v)
      : typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        ? BigInt(v)
        : null;
  const i = asNumber(index);
  const a = asNumber(amount);
  if (i === null || a === null || i >= 2n ** 32n || a >= 2n ** 128n)
    return null;
  if (
    !Array.isArray(proof) ||
    proof.length > MAX_PROOF ||
    !proof.every((p) => typeof p === "string" && HASH.test(p))
  )
    return null;
  return {
    index: i,
    amount: a,
    proof: (proof as string[]).map((p) => p.toLowerCase()),
  };
}

/** A link as the person who holds the list would make it (also used by the loop's own list maker). */
export function earlierLinkFragment(link: EarlierLink): string {
  const json = JSON.stringify({
    index: link.index.toString(),
    amount: link.amount.toString(),
    proof: link.proof,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `#${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** Everything the decision stands on. */
export interface EarlierInputs {
  /** The signed-in account's address, or null when nobody is signed in. */
  account: string | null;
  link: EarlierLink | null;
  /** The record's claim key; null or absent when the project has none. */
  record: { bound: boolean; root: string; textHash: string } | null;
  /** The text fingerprint this build was given. */
  buildTextHash: string;
  /** What the network says now; null while it has not been read. */
  chain: { textHash: string; bound: boolean; claimed: boolean } | null;
}

export type EarlierState =
  | { kind: "sign-in" }
  | { kind: "not-open" }
  | { kind: "texts-differ" }
  | { kind: "not-for-you" }
  | { kind: "claimed" }
  | { kind: "reading" }
  | { kind: "row"; row: EarlierRow; link: EarlierLink };

/**
 * What the page shows. The order: sign in, then whether claims are open (and whether the build's text is the network's), then
 * whether the link is this account's, then whether it is claimed. The fingerprints are compared before the row is shown, so a page
 * built for another text never offers a press.
 */
export function earlierState(input: EarlierInputs): EarlierState {
  if (!input.account) return { kind: "sign-in" };
  const { record, chain } = input;
  if (!record?.bound) return { kind: "not-open" };
  // The record, the build and the network each name the text; a page where they differ is not one to accept on.
  if (record.textHash.toLowerCase() !== input.buildTextHash.toLowerCase())
    return { kind: "texts-differ" };
  if (!chain) return { kind: "reading" };
  if (!chain.bound) return { kind: "not-open" };
  if (chain.textHash.toLowerCase() !== input.buildTextHash.toLowerCase())
    return { kind: "texts-differ" };
  const link = input.link;
  if (!link) return { kind: "not-for-you" };
  const row: EarlierRow = {
    index: link.index,
    account: input.account,
    amount: link.amount,
  };
  // The proof is checked against the fingerprint the record names for the list, for THIS account: another account's link,
  // a link cut or altered, or one for another list all read the same.
  if (!verifyEarlierRow(row, link.proof, record.root))
    return { kind: "not-for-you" };
  if (chain.claimed) return { kind: "claimed" };
  return { kind: "row", row, link };
}
