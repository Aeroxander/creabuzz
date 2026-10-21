/**
 * Suggested work (D84): anyone, holding Shares or not, can suggest a piece of work for a project and name their price;
 * any holder who can open votes can then put it to a vote as an "Approve a project" decision, filled in from the
 * suggestion. Nothing is paid by suggesting: once approved, the person files claims like anyone else, the reviewers
 * judge them, and the project votes each award.
 *
 * A suggestion is a board post (kind 45001) with these tags beside its board (`h`):
 *
 * - `["t", "work-proposal"]` and `["t", "work-proposal:<chainId>:<dao>"]`: which project it is for, so the project can
 *   find it with one read, and it shows on the board and in Home's timeline like any discussion;
 * - `["project", "<short name>"]`: the project's name if approved (32 bytes at most, as the work budget stores it);
 * - `["ask", "<whole Shares>"]`: the price;
 * - `["check", "<what finished work looks like>"]`: the words claims will state and reviewers judge against.
 *
 * The ask is in Shares; people think in percent, so the form converts both ways against the Shares that exist now:
 * asking for 5% of the project means enough Shares to hold 5% once they are added.
 *
 * Alias-free: `work-proposal.test.mjs` drives it under `node --test`.
 */

import { hashText, idWord } from "@creaton/core/launchpad/work.ts";
import { KIND_FORUM_POST } from "../../board/lib/board-events.ts";
import { composePost, splitPost } from "../../board/lib/post-text.ts";

export const WORK_PROPOSAL_TOPIC = "work-proposal";
export const PROJECT_NAME_MAX = 32;
export const CHECK_MIN = 5;
export const CHECK_MAX = 280;
export const MAX_ASK = 1_000_000_000n;

export function workProposalTopic(
  chainId: string | number,
  dao: string,
): string {
  return `${WORK_PROPOSAL_TOPIC}:${chainId}:${dao.toLowerCase()}`;
}

export interface WorkProposalInput {
  boardId: string;
  chainId: string | number;
  dao: string;
  title: string;
  /** What the person will do, in their words. */
  body: string;
  /** The project's short name, if approved. */
  name: string;
  askWhole: bigint;
  check: string;
}

/** Why a suggestion cannot be posted, in plain words, or null. */
export function proposalProblem(
  input: Omit<WorkProposalInput, "boardId" | "chainId" | "dao">,
): string | null {
  if (input.title.trim().length < 3)
    return "Say in a few words what you will do.";
  const name = input.name.trim();
  if (name === "") return "Give the work a short name, like a project's.";
  if (new TextEncoder().encode(name).length > PROJECT_NAME_MAX)
    return `Keep the short name to ${PROJECT_NAME_MAX} letters.`;
  if (name.startsWith("0x")) return "Start the short name with a letter.";
  const check = input.check.trim();
  if (check.length < CHECK_MIN)
    return "Say what finished work looks like, so reviewers know what to check.";
  if (check.length > CHECK_MAX)
    return `Keep what finished work looks like under ${CHECK_MAX} characters.`;
  if (input.askWhole <= 0n) return "Ask for some Shares: at least one.";
  if (input.askWhole > MAX_ASK)
    return "That is more Shares than one piece of work can ask for.";
  return null;
}

/** The board post for a suggestion. Throws the plain problem when it cannot be posted. */
export function workProposalDraft(input: WorkProposalInput): {
  kind: number;
  tags: string[][];
  content: string;
} {
  const problem = proposalProblem(input);
  if (problem) throw new Error(problem);
  return {
    kind: KIND_FORUM_POST,
    tags: [
      ["h", input.boardId],
      ["t", WORK_PROPOSAL_TOPIC],
      ["t", workProposalTopic(input.chainId, input.dao)],
      ["project", input.name.trim()],
      ["ask", input.askWhole.toString()],
      ["check", input.check.trim()],
    ],
    content: composePost(input.title, input.body),
  };
}

export interface WorkProposal {
  id: string;
  author: string;
  boardId: string;
  createdAt: number;
  title: string;
  body: string;
  name: string;
  askWhole: bigint;
  check: string;
  /** What a project approved from it is keyed and judged by (`idWord(name)`, `hashText(check)`). */
  projectId: string;
  checkHash: string;
}

function tag(tags: readonly string[][], name: string): string | null {
  const value = tags.find((t) => t[0] === name)?.[1];
  return typeof value === "string" ? value : null;
}

/** A suggestion for this project from a board post, or null when the post is not one (or not well formed). */
export function parseWorkProposal(
  event: {
    id: string;
    pubkey: string;
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  },
  chainId: string | number,
  dao: string,
): WorkProposal | null {
  if (event.kind !== KIND_FORUM_POST) return null;
  const topic = workProposalTopic(chainId, dao);
  if (!event.tags.some((t) => t[0] === "t" && t[1] === topic)) return null;
  const boardId = tag(event.tags, "h");
  const name = tag(event.tags, "project")?.trim() ?? "";
  const askText = tag(event.tags, "ask") ?? "";
  const check = tag(event.tags, "check")?.trim() ?? "";
  if (!boardId || !/^\d{1,10}$/.test(askText)) return null;
  const askWhole = BigInt(askText);
  const { title, body } = splitPost(event.content);
  if (proposalProblem({ title, body, name, askWhole, check }) !== null)
    return null;
  return {
    id: event.id,
    author: event.pubkey,
    boardId,
    createdAt: event.created_at,
    title,
    body,
    name,
    askWhole,
    check,
    projectId: idWord(name),
    checkHash: hashText(check),
  };
}

/**
 * Shares to ask for to hold `bps` (basis points of 10,000) of the project once they are added to the `supplyWhole`
 * that exist now: x / (S + x) = p, so x = S·p / (1 − p). Rounded up, so the ask reaches the share.
 */
export function askForShare(bps: number, supplyWhole: bigint): bigint {
  if (!Number.isInteger(bps) || bps <= 0 || bps >= 10_000)
    throw new Error("a share is between 0% and 100%");
  const p = BigInt(bps);
  const numerator = supplyWhole * p;
  const denominator = 10_000n - p;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The share (basis points) `askWhole` would be of the project once added to the `supplyWhole` that exist now. It is
 * also how much everyone else's part shrinks: each holder keeps (1 − this) of what they had.
 */
export function shareAfter(askWhole: bigint, supplyWhole: bigint): number {
  const total = supplyWhole + askWhole;
  return total === 0n ? 0 : Number((askWhole * 10_000n) / total);
}

/** Where a suggestion stands against the projects the DAO has approved. */
export type ProposalStatus = "suggested" | "approved";

export function proposalStatus(
  proposal: Pick<WorkProposal, "projectId" | "checkHash">,
  approved: readonly { projectId: string; checkHash: string }[],
): ProposalStatus {
  return approved.some(
    (p) =>
      p.projectId.toLowerCase() === proposal.projectId.toLowerCase() &&
      p.checkHash.toLowerCase() === proposal.checkHash.toLowerCase(),
  )
    ? "approved"
    : "suggested";
}
