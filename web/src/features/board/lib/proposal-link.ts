/**
 * Tying a board post to a DAO decision.
 *
 * A post about a decision carries the topic `proposal:<chain>:<dao>:<id>` as a
 * hashtag-style `t` tag, so every thread about one decision is found with one
 * filter, plus the plain topic `proposal` so the board can offer a "Proposals"
 * filter. The tag is a claim by whoever wrote the post: it names a decision,
 * it does not prove the post is about it. Anything shown from the chain for
 * such a thread is read from the DAO's own record (see `ProposalHeader`),
 * never from the post text.
 *
 * Alias-free; `proposal-link.test.mjs` drives it under `node --test`.
 */

export const PROPOSAL_TOPIC = "proposal";

export interface ProposalRef {
  chainId: number;
  /** The DAO's address, lower case. */
  dao: string;
  /** The proposal id, `0x` + 64 lower-case hex. */
  id: string;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PROPOSAL_ID = /^0x[0-9a-f]{64}$/;

/** The topic for a decision, or null when any part is not what it should be. */
export function proposalTopic(ref: ProposalRef): string | null {
  const dao = ref.dao.toLowerCase();
  const id = ref.id.toLowerCase();
  if (!Number.isSafeInteger(ref.chainId) || ref.chainId <= 0) return null;
  if (!ADDRESS.test(dao) || !PROPOSAL_ID.test(id)) return null;
  return `${PROPOSAL_TOPIC}:${ref.chainId}:${dao}:${id}`;
}

/** The decision a topic names, or null for anything that is not exactly that shape. */
export function parseProposalTopic(topic: string): ProposalRef | null {
  const parts = topic.split(":");
  if (parts.length !== 4 || parts[0] !== PROPOSAL_TOPIC) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(parts[1])) return null;
  const ref = { chainId: Number(parts[1]), dao: parts[2], id: parts[3] };
  return proposalTopic(ref) === topic ? ref : null;
}

/** The decision a post's tags name, if they name exactly one well-formed decision. */
export function proposalOf(tags: readonly string[][]): ProposalRef | null {
  const found = tags
    .filter((tag) => tag[0] === "t" && typeof tag[1] === "string")
    .map((tag) => parseProposalTopic(tag[1]))
    .filter((ref): ref is ProposalRef => ref !== null);
  return found.length === 1 ? found[0] : null;
}

/** Is this the same decision? */
export function sameProposal(a: ProposalRef, b: ProposalRef): boolean {
  return a.chainId === b.chainId && a.dao === b.dao && a.id === b.id;
}
