/**
 * Why a reviewer turned a submission down, kept where the contributor can read it.
 *
 * The verdict itself is on the chain (`VerifierSet.attest(claim, false)`), and it carries no words. So a reviewer who
 * turns work down may also publish a reason, signed, as a project update that names the claim, the budget and the
 * reviewer's wallet: the same way a contributor publishes the evidence for a claim (`evidence.ts`).
 *
 * A reason is shown only when it can be tied to a real turn-down: the wallet it names turned this claim down on the
 * chain, and the person who signed it bound that wallet to their account. Anyone can publish an update, so a reason
 * that fails either check is never shown as a reviewer's.
 *
 * The reason is published before the turn-down is sent: a reason whose turn-down never landed is never shown, so a
 * failure at either step leaves nothing misleading behind, and pressing the button again finishes it.
 *
 * A reason may also name its cause (`REASON_CAUSES`): what was missing, chosen from a short list, so turn-downs can be
 * counted by cause across the whole project (`causeTally`). Most causes sit in how the work was set up (an unclear
 * "done when", missing access, missing context), which the founder can fix, rather than in the person.
 *
 * Pure and alias-free: `review-reasons.test.mjs` drives it under `node --test`.
 */

import { urlsIn } from "./evidence.ts";

/** The most a reason can say: it travels in a signed event, and the contributor has to read it. */
export const REASON_MAX_CHARS = 2_000;

/** What a reviewer can say was missing, in the order the form offers them. */
export const REASON_CAUSES = [
  { key: "unclear-done", label: 'The "done when" was unclear' },
  { key: "missing-access", label: "Missing access or information" },
  { key: "missing-context", label: "The person or their AI lacked context" },
  { key: "quality", label: "Not good enough yet" },
  { key: "other", label: "Something else" },
] as const;

export type ReasonCause = (typeof REASON_CAUSES)[number]["key"];

const CAUSE_KEYS: ReadonlySet<string> = new Set(
  REASON_CAUSES.map((c) => c.key),
);

const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface ReviewReason {
  eventId: string;
  /** The key that signed it. */
  author: string;
  createdAt: number;
  claimId: string;
  mandate: string;
  /** The wallet it says turned the claim down, lower case. */
  reviewer: string;
  /** May be empty when the reviewer only chose a cause. */
  reason: string;
  cause: ReasonCause | null;
}

/** The content of the update that publishes a reviewer's reason for turning a claim down. */
export function reviewReasonContent(input: {
  name: string;
  claimId: string;
  mandate: string;
  reviewer: string;
  reason: string;
  cause?: ReasonCause | null;
}): Record<string, unknown> {
  return {
    title: `Turned down: ${input.name}`,
    body: input.reason.trim(),
    links: urlsIn(input.reason),
    review: {
      id: input.claimId.toLowerCase(),
      mandate: input.mandate.toLowerCase(),
      reviewer: input.reviewer.toLowerCase(),
      verdict: "object",
      ...(input.cause ? { cause: input.cause } : {}),
    },
  };
}

/** A reason out of a raw update event, or null when it is not one (or names its claim badly). */
export function parseReviewReason(event: {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
}): ReviewReason | null {
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  const { body: text, review } = body as { body?: unknown; review?: unknown };
  if (review === null || typeof review !== "object") return null;
  const raw = review as Record<string, unknown>;
  if (
    raw.verdict !== "object" ||
    typeof raw.id !== "string" ||
    !WORD_RE.test(raw.id) ||
    typeof raw.mandate !== "string" ||
    !ADDRESS_RE.test(raw.mandate) ||
    typeof raw.reviewer !== "string" ||
    !ADDRESS_RE.test(raw.reviewer) ||
    typeof text !== "string"
  ) {
    return null;
  }
  const cause =
    typeof raw.cause === "string" && CAUSE_KEYS.has(raw.cause)
      ? (raw.cause as ReasonCause)
      : null;
  // A reason says something: words, a cause, or both.
  if (text.trim() === "" && cause === null) return null;
  return {
    eventId: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    claimId: raw.id.toLowerCase(),
    mandate: raw.mandate.toLowerCase(),
    reviewer: raw.reviewer.toLowerCase(),
    reason: text.slice(0, REASON_MAX_CHARS),
    cause,
  };
}

/** The words a cause is shown with. */
export function causeLabel(cause: ReasonCause): string {
  return REASON_CAUSES.find((c) => c.key === cause)?.label ?? cause;
}

/**
 * Turn-downs counted by cause across the project, from the reasons shown for each turned-down claim: a claim counts
 * once for each cause its reviewers named, and once as "no cause given" when none did. Most common first.
 */
export function causeTally(perClaim: readonly (readonly ReviewReason[])[]): {
  byCause: { cause: ReasonCause; label: string; count: number }[];
  withoutCause: number;
} {
  const counts = new Map<ReasonCause, number>();
  let withoutCause = 0;
  for (const reasons of perClaim) {
    const causes = new Set(reasons.flatMap((r) => (r.cause ? [r.cause] : [])));
    if (causes.size === 0) withoutCause += 1;
    for (const cause of causes) counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  const order = REASON_CAUSES.map((c) => c.key as ReasonCause);
  return {
    byCause: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([cause, count]) => ({ cause, label: causeLabel(cause), count })),
    withoutCause,
  };
}

/** Why a reason cannot be published as typed, in plain words, or null. Saying nothing is allowed. */
export function reasonProblem(reason: string): string | null {
  return reason.length > REASON_MAX_CHARS
    ? `Keep the reason under ${REASON_MAX_CHARS.toLocaleString("en-US")} characters.`
    : null;
}

/** How a key's binding to a wallet is named in the set `boundWallets` returns. */
function bindingKey(pubkey: string, address: string): string {
  return `${pubkey}:${address.toLowerCase()}`;
}

/**
 * Whether a reason `author` signs, naming `reviewer`'s wallet, would be shown: the check `reasonsFor` makes, asked
 * before the reason is published, so a reviewer whose account is not linked to their name is told rather than writing
 * a reason nobody will see.
 */
export function reasonWouldShow(
  bound: ReadonlySet<string>,
  author: string,
  reviewer: string,
): boolean {
  return bound.has(bindingKey(author, reviewer));
}

/**
 * The wallets each key has bound, from binding records: the newest record per key and wallet decides (a withdrawn one
 * unbinds it). Keys are `pubkey:address`, lower-case address.
 */
export function boundWallets(
  records: readonly {
    pubkey: string;
    address: string;
    revoked: boolean;
    createdAt: number;
    eventId: string;
  }[],
): Set<string> {
  const newest = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const key = bindingKey(record.pubkey, record.address);
    const current = newest.get(key);
    if (
      !current ||
      record.createdAt > current.createdAt ||
      (record.createdAt === current.createdAt &&
        record.eventId < current.eventId)
    ) {
      newest.set(key, record);
    }
  }
  return new Set(
    [...newest.entries()].filter(([, r]) => !r.revoked).map(([key]) => key),
  );
}

/**
 * The reasons that can be shown for one claim: those naming this claim in this budget, from a wallet that turned it down
 * on the chain (`objectedBy`), signed by the person who bound that wallet (`bound`, from `boundWallets`). The newest per
 * reviewer, oldest reviewer first. Nothing is shown while the turn-downs are not known.
 */
export function reasonsFor(
  claim: { id: string; mandate: string },
  reasons: readonly ReviewReason[],
  objectedBy: readonly string[] | null,
  bound: ReadonlySet<string>,
): ReviewReason[] {
  if (objectedBy === null) return [];
  const objected = new Set(objectedBy.map((a) => a.toLowerCase()));
  const id = claim.id.toLowerCase();
  const mandate = claim.mandate.toLowerCase();
  const newest = new Map<string, ReviewReason>();
  for (const reason of reasons) {
    if (reason.claimId !== id || reason.mandate !== mandate) continue;
    if (!objected.has(reason.reviewer)) continue;
    if (!reasonWouldShow(bound, reason.author, reason.reviewer)) continue;
    const current = newest.get(reason.reviewer);
    if (!current || reason.createdAt > current.createdAt) {
      newest.set(reason.reviewer, reason);
    }
  }
  return [...newest.values()].sort((a, b) => a.createdAt - b.createdAt);
}
