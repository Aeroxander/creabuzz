/**
 * The agreed-reward lane as the Work tab shows it: the plain words and the one
 * next step each agreement implies, decided only from real chain state and
 * real timestamps.
 *
 * Every call wraps the shared core adapter (`agreements.ts`) — its
 * `nextAgreementAction` stays the source of the words — and adds what the
 * screen needs beside it: the machine kind of the step (which form or button
 * it belongs to), the challenge-window gate on settlement (the contract waits
 * it out; the page must say so instead of offering a send that reverts), the
 * payees a claim's review must exclude, the claims the legacy award-vote path
 * must leave alone, and the deliverable / corrections words as they were
 * published beside the chain in a launch update.
 *
 * Alias-free so `agreed-lane.test.mjs` binds it under `node --test`.
 */

import {
  agreementIdOf,
  deliverableSlotKey,
  nextAgreementAction,
  splitQuantities,
  type AgreementTerms,
  type ClaimStatus,
} from "@creaton/core/launchpad/agreements.ts";
import type { AgreementRow } from "@creaton/core/launchpad/agreementsRead.ts";
import { bindCandidates } from "./agreed-submission.ts";

// ── the lane's words for its capability ─────────────────────────────────────

/** What the lane says about a mandate whose agreed-reward lane could be read. */
export function capabilityHeadline(
  capability: "supported" | "unsupported" | "known-legacy" | "unreadable",
): string {
  switch (capability) {
    case "supported":
      return "Agreed rewards run on their exact terms here.";
    case "unsupported":
      return "Agreed rewards on this budget use a version this screen cannot follow yet. Existing work keeps working as before; nothing is changed or held up.";
    case "known-legacy":
      return "This budget ran before agreed rewards existed, so it keeps its existing manual flow.";
    default:
      return "Could not read this budget's agreed rewards just now. Nothing here is left out on purpose — try again in a minute.";
  }
}

// ── one agreement's next step ───────────────────────────────────────────────

export type LaneStepKind =
  | "accept"
  | "submit"
  | "corrections"
  | "bind"
  | "request-corrections"
  | "review"
  | "settle-claim"
  | "settle-agreement"
  | "release"
  | "wait"
  | "info"
  | "done";

/** The one lane step an agreement has open right now, for a screen's viewer. */
export interface LaneStep {
  kind: LaneStepKind;
  actor: string;
  note: string;
  due: number | null;
  /** What the date `due` marks, so the page names the window instead of implying a clock acts. */
  dueLine: string | null;
}

/** What the claim can read about the attempt, if the attempt is in the record. */
export type AttemptClaim = {
  record: { status: string; releasedAt: number; expiresAt: number };
  approvals: number;
  objections: number;
} | null;

export interface LaneContext {
  now: number;
  /** The panel's actual quorum, as the mandate read it. */
  quorum: number;
  /** The challenge window the bound attempt's approval waits out, in seconds. */
  challengeWindow: number;
  /** Whether a reviewer formally asked for corrections; null when unreadable. */
  correctionsRequested: boolean | null;
  viewer?: {
    manager?: boolean;
    beneficiary?: boolean;
    reviewer?: boolean;
  } | null;
}

/**
 * The screen's one next step for an agreement: the core adapter's own
 * reasoning, with a machine kind for the form it belongs to, and settlement
 * held until its challenge window really ended. A step the viewer cannot take
 * keeps its reason as words and carries no offered action.
 */
export function laneStep(
  row: AgreementRow,
  claim: AttemptClaim,
  context: LaneContext,
): LaneStep | null {
  if (row.kind !== "present") return null;
  const terms = row.terms;
  const now = context.now;
  const status: ClaimStatus | undefined =
    claim !== null ? (claim.record.status as ClaimStatus) : undefined;
  const next = nextAgreementAction(terms, now, {
    claimStatus: status ?? null,
    reviewDeadline: claim !== null ? claim.record.expiresAt : null,
    quorum: context.quorum,
    approvals: claim?.approvals ?? null,
    correctionsRequested: context.correctionsRequested ?? undefined,
    challengeWindow: context.challengeWindow,
    viewer: context.viewer,
  });
  if (!next) return null;
  const base: LaneStep = {
    kind: "info",
    actor: next.actor,
    note: next.note,
    due: next.due,
    dueLine: null,
  };
  const revisionOpen = now < terms.revisionDeadline;
  switch (next.state) {
    case "absent":
    case "cancelled":
    case "expired":
    case "settled":
      return { ...base, kind: "done" };
    case "offered":
      if (next.due !== null && now < next.due) {
        return {
          ...base,
          kind: "accept",
          dueLine: "The offer needs an answer by",
        };
      }
      return { ...base, kind: "release" };
    case "agreed": {
      if (!terms.claimId) {
        if (next.due !== null && now < next.due) {
          return { ...base, kind: "submit", dueLine: "The work is due by" };
        }
        return { ...base, kind: "release" };
      }
      return base;
    }
    case "in-review": {
      // An attempt the work read could not bring is unknown, not judged.
      if (claim === null) {
        return {
          kind: "info",
          actor: "none",
          note: "The attempt's state could not be read yet, so nothing is named as a next step here.",
          due: null,
          dueLine: null,
        };
      }
      if (status === "Open") {
        // The review's own window decides first, as the core adapter does.
        const reviewDeadline = claim !== null ? claim.record.expiresAt : null;
        if (reviewDeadline !== null && now >= reviewDeadline) {
          // Past its review window the attempt lapses; the claim's own
          // "close as lapsed" belongs to the claim row.
          return { ...base, kind: "info" };
        }
        if (context.correctionsRequested && revisionOpen) {
          return {
            ...base,
            kind: "corrections",
            dueLine: "The corrected attempt is due by",
          };
        }
        const quorum = context.quorum;
        if (quorum > 0 && (claim?.approvals ?? 0) >= quorum) {
          return { ...base, kind: "settle-claim" };
        }
        return { ...base, kind: "review" };
      }
      if (
        status === "Rejected" ||
        status === "Expired" ||
        status === "Recovered"
      ) {
        return { ...base, kind: "release" };
      }
      // Frozen: no award while it is in dispute, and no step anyone can take here.
      return { ...base, kind: "info" };
    }
    case "ready-to-settle": {
      if (claim === null || status === undefined) return base;
      const ready = windowEnded(
        claim.record.releasedAt,
        context.challengeWindow,
        now,
        status,
      );
      if (!ready) {
        return {
          ...base,
          kind: "wait",
          due:
            status === "Approved"
              ? claim.record.releasedAt + context.challengeWindow
              : null,
          dueLine: "The challenge window ends",
          note: "Approved on its exact terms. Once the challenge window ends, anyone can settle the agreement at its reserved quantity. Nothing can be paid inside the window.",
        };
      }
      return { ...base, kind: "settle-agreement" };
    }
    default:
      return base;
  }
}

/** Whether a settled or finished claim can settle its agreement. */
function windowEnded(
  releasedAt: number,
  challengeWindow: number,
  now: number,
  status: string,
): boolean {
  // A finite claim somebody already paid is definitely settleable.
  if (status === "Paid") return true;
  const end = releasedAt + challengeWindow;
  return end > 0 && now >= end;
}

// ── who the payments name ───────────────────────────────────────────────────

/**
 * What a claim's settlement would pay, as the record's split declares: the
 * beneficiary and every declared party when a split was agreed. The panel
 * excludes them from judging — the contract enforces it at the claim's
 * binding, and the page shows it too.
 */
export function awardPayees(
  row: AgreementRow,
): { addresses: string[]; quantity: bigint } | null {
  if (row.kind !== "present") return null;
  const payees =
    row.split.kind === "declared" ? row.split.parties : [row.terms.beneficiary];
  return { addresses: payees, quantity: row.terms.shares };
}

/** Whether the wallet may judge this claim at all (nobody rewards themselves). */
export function mayReview(
  claimAgreement: AgreementRow | null,
  wallet: string | null,
): boolean {
  if (!wallet || !claimAgreement || claimAgreement.kind !== "present")
    return true;
  const payees = awardPayees(claimAgreement);
  return !(payees?.addresses.includes(wallet.toLowerCase()) ?? false);
}

/** A claim's settlement would pay these wallets and nobody else may judge it. */
export function reviewPayeesOf(row: AgreementRow | null): string[] {
  if (row === null || row.kind !== "present") return [];
  return row.split.kind === "declared"
    ? row.split.parties
    : [row.terms.beneficiary];
}

/**
 * Whether a claim's approval quorum really stands and no objection quorum
 * does. Finishing a claim in any other state can turn it down (and, on agreed
 * work, slash its attempt), so only this state offers a "finish" that is
 * certain to approve.
 */
export function approvedQuorumStands(claim: {
  approvals: number;
  objections: number;
  quorum: number;
}): boolean {
  return (
    claim.quorum > 0 &&
    claim.approvals >= claim.quorum &&
    claim.objections < claim.quorum
  );
}

/**
 * The claims the legacy award-vote path must leave alone: every claim the
 * chain bound to an agreement, current attempts included and superseded
 * attempts too — the escrow refuses an award on any of them. `null` means
 * "not confirmed bound", never "confirmed unbound".
 */
export function awardVoteBlockedOn(
  lane:
    | {
        /** Claim ids the reads confirmed are bound to an agreement, lower case. */
        boundClaims: ReadonlyMap<string, string>;
        /** The lane's agreements, as the read carries them. */
        agreements: readonly { row: AgreementRow }[];
      }
    | undefined,
  claimId: string,
): boolean | null {
  if (!lane) return null;
  const bound = lane.boundClaims.get(claimId.toLowerCase());
  if (bound !== undefined) return true;
  const current = lane.agreements.some(
    (item) =>
      item.row.kind === "present" &&
      item.row.terms.claimId?.toLowerCase() === claimId.toLowerCase(),
  );
  return current ? true : null;
}

/**
 * The claims that are an unbound agreement's own attempt: its beneficiary, the
 * agreed check, no currency ask, still open and gathered to no work area. The
 * legacy manager bind must leave them alone — binding one through the work
 * area would take the attempt away from the agreement's own binding, and the
 * agreed quantity could then never settle on it.
 */
export function agreedAwaitingBind(
  lane: { agreements: readonly { row: AgreementRow }[] } | undefined,
  claims: Parameters<typeof bindCandidates>[0]["claims"],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const item of lane?.agreements ?? []) {
    if (item.row.kind !== "present" || item.row.terms.claimId) continue;
    for (const candidate of bindCandidates({ row: item.row, claims })) {
      out.add(candidate.id.toLowerCase());
    }
  }
  return out;
}

/**
 * Who a claim's review must exclude, read from the agreement it rides: the
 * beneficiary plus every declared split party.
 */
export function reviewBlockedPayees(
  lane: { agreements: readonly { row: AgreementRow }[] } | undefined,
  claimId: string,
): string[] {
  if (!lane) return [];
  for (const item of lane.agreements) {
    if (
      item.row.kind === "present" &&
      item.row.terms.claimId?.toLowerCase() === claimId.toLowerCase()
    ) {
      return reviewPayeesOf(item.row);
    }
  }
  return [];
}

// ── the deliverable and corrections words, as they were published ────────────

/** One agreement's words as they were published beside the chain. */
export interface AgreementDescriptor {
  /** The event the words were published in. */
  eventId: string;
  author: string;
  createdAt: number;
  agreementId: string;
  mandate: string;
  projectId: string;
  /** The deliverable, in the manager's own words: it hashes to the agreement's slot. */
  deliverable: string;
  /** The criteria words, once the manager confirmed those too. */
  criteriaWords?: string;
  /** Who else shares the reward and how much of it (basis points), when declared. */
  recipients?: { address: string; percentBps: number }[];
}

/** The corrections words a reviewer published for a request, checked against the claim it names. */
export interface CorrectionsWords {
  eventId: string;
  author: string;
  createdAt: number;
  claimId: string;
  mandate: string;
  /** The agreement the corrections were asked on. */
  agreementId: string;
  reason: string;
}

/**
 * The launch update that publishes an agreement's deliverable. The screen
 * reads those back from the same updates everything else on it already reads:
 * the existing project-update kind carries the words, so no new server event
 * kind is made and no other flow needs to change.
 */
export function agreedTermsUpdateContent(input: {
  agreementId: string;
  mandate: string;
  projectId: string;
  deliverable: string;
  criteriaWords?: string | null;
  recipients?: readonly { address: string; percentBps: number }[] | null;
}): Record<string, unknown> {
  return {
    title: `Agreed work: ${input.deliverable}`,
    body: input.deliverable,
    agreement: {
      id: input.agreementId.toLowerCase(),
      mandate: input.mandate.toLowerCase(),
      projectId: input.projectId.toLowerCase(),
      deliverable: input.deliverable,
      ...(input.criteriaWords ? { criteriaWords: input.criteriaWords } : {}),
      ...(input.recipients && input.recipients.length > 0
        ? {
            recipients: input.recipients.map((party) => ({
              address: party.address.toLowerCase(),
              percentBps: party.percentBps,
            })),
          }
        : {}),
    },
  };
}

/**
 * The launch update that publishes a reviewer's corrections request. The
 * request itself is on the chain as a hash (`VerifierSet.requestCorrections`):
 * a non-final ask for changes, never a verdict.
 */
export function agreedCorrectionsContent(input: {
  claimId: string;
  mandate: string;
  agreementId: string;
  reason: string;
}): Record<string, unknown> {
  return {
    title: `Corrections requested on agreed work`,
    body: `${input.agreementId.toLowerCase()}: ${input.reason}`,
    agreementCorrections: {
      claimId: input.claimId.toLowerCase(),
      mandate: input.mandate.toLowerCase(),
      agreementId: input.agreementId.toLowerCase(),
      reason: input.reason,
    },
  };
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function wordOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
}

function addressOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

/** The agreement terms an update carries, only when every field says what it means. */
export function parseAgreementDescriptor(
  raw: unknown,
): Omit<AgreementDescriptor, "eventId" | "author" | "createdAt"> | null {
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const agreementId = wordOf(body.id);
  const mandate = addressOf(body.mandate);
  const projectId = wordOf(body.projectId);
  const deliverable = textOf(body.deliverable);
  if (!agreementId || !mandate || !projectId || !deliverable?.trim())
    return null;
  const criteriaWords = textOf(body.criteriaWords);
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const party = entry as Record<string, unknown>;
        const address = addressOf(party.address);
        const percent =
          typeof party.percentBps === "number" ? party.percentBps : null;
        return address &&
          percent !== null &&
          Number.isInteger(percent) &&
          percent >= 0
          ? [{ address, percentBps: percent }]
          : [];
      })
    : [];
  const parsed: Omit<AgreementDescriptor, "eventId" | "author" | "createdAt"> =
    {
      agreementId,
      mandate,
      projectId,
      deliverable: deliverable.trim(),
      ...(criteriaWords?.trim() ? { criteriaWords: criteriaWords } : {}),
      ...(recipients.length > 0 ? { recipients } : {}),
    };
  return parsed;
}

/** The corrections words an update carries, only when they name a real claim. */
export function parseCorrectionsWords(raw: unknown): {
  claimId: string;
  mandate: string;
  agreementId: string;
  reason: string;
} | null {
  if (raw === null || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const claimId = wordOf(body.claimId);
  const mandate = addressOf(body.mandate);
  const agreementId = wordOf(body.agreementId);
  const reason = textOf(body.reason);
  if (!claimId || !mandate || !agreementId || !reason?.trim()) return null;
  return { claimId, mandate, agreementId, reason: reason.trim() };
}

/**
 * The agreements' words carried by a launch's updates, newest first, one per
 * agreement id (the newest publishing wins — re-publishing fixed words is the
 * manager's retry, not a second offer).
 */
export function descriptorsOfEvents(
  events: readonly {
    id: string;
    pubkey: string;
    created_at: number;
    content: string;
  }[],
  contentOf: (raw: string) => Record<string, unknown> | null,
): AgreementDescriptor[] {
  const byId = new Map<string, AgreementDescriptor>();
  for (const event of events) {
    const body = contentOf(event.content);
    if (body === null) continue;
    const parsed = parseAgreementDescriptor(body.agreement);
    if (!parsed) continue;
    const lower = parsed.agreementId.toLowerCase();
    const current = byId.get(lower);
    if (current && current.createdAt >= event.created_at) continue;
    byId.set(lower, {
      ...parsed,
      agreementId: lower,
      mandate: parsed.mandate.toLowerCase(),
      projectId: parsed.projectId.toLowerCase(),
      eventId: event.id,
      author: event.pubkey,
      createdAt: event.created_at,
    });
  }
  return [...byId.values()];
}

/** The published corrections words for one claim, newest first. */
export function correctionsOfEvents(
  events: readonly {
    id: string;
    pubkey: string;
    created_at: number;
    content: string;
  }[],
  contentOf: (raw: string) => Record<string, unknown> | null,
): CorrectionsWords[] {
  const out: CorrectionsWords[] = [];
  for (const event of events) {
    const body = contentOf(event.content);
    if (body === null) continue;
    const parsed = parseCorrectionsWords(body.agreementCorrections);
    if (!parsed) continue;
    out.push({
      eventId: event.id,
      author: event.pubkey,
      createdAt: event.created_at,
      claimId: parsed.claimId.toLowerCase(),
      mandate: parsed.mandate.toLowerCase(),
      agreementId: parsed.agreementId.toLowerCase(),
      reason: parsed.reason,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Whether a deliverable's words are the ones the proposal actually committed:
 * the agreement id is the hash of the project and the deliverable, so
 * re-hashing the published text proves (or refuses) it.
 */
export function deliverableMatches(
  terms: AgreementTerms,
  deliverable: string,
): boolean {
  try {
    return (
      agreementIdOf(terms.projectId, deliverableSlotKey(deliverable)) ===
      terms.id.toLowerCase()
    );
  } catch {
    return false;
  }
}

// ── figures ────────────────────────────────────────────────────────────────

/**
 * What each declared recipient takes when the agreement settles: whole token
 * units per declared party, the deterministic residual to the first. A split
 * that never declared parts has the beneficiary take the whole quantity.
 */
export function settlementFigures(
  row: AgreementRow & { kind: "present" },
): { address: string; quantity: bigint }[] {
  if (row.split.kind === "declared") {
    const parts = splitQuantities(row.terms.shares, row.split.percentages);
    return row.split.parties.map((address, index) => ({
      address,
      quantity: parts[index],
    }));
  }
  return [{ address: row.terms.beneficiary, quantity: row.terms.shares }];
}
