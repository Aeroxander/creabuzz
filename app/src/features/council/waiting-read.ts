/**
 * The Council's calls that can still run, read from the chain so a seat never proposes a step twice. Every `Proposed`
 * log of the Council over a bounded window is kept only where the Council's own record of the proposal is still there
 * and still in time (`Council.proposals`, `PROPOSAL_TTL`, the seat generation): a call that ran, was taken back, ran
 * out, or died when a seat changed is not waiting, so the same step may be proposed again.
 *
 * The Pair's own reader (`pot/use-pair-waiting.ts`) serves a Pair. Both this and that answer one question for the same
 * callers (`tasks/PayFromBox.tsx`, `tasks/chain/team/PlanSheet.tsx`): "is this step already waiting in the runner?", so
 * the rows are the same shape (`target` and `data`) and the callers' comparisons read the same either way. What differs
 * is how a Council says what is waiting: `proposals(id)` is its record, where a Pair answers `proposer`/`proposedAt`.
 * Bounded: one log window and one read per proposal found. Nothing here writes.
 */
import { decodeReturn, encodeCall } from "@creaton/core/pot/abi-codec.ts";
import { COUNCIL_ABI } from "@creaton/core/pot/abis.generated.ts";
import type { ReadCall } from "@creaton/core/pot/pot-reads.ts";
import {
  type CouncilProposal,
  councilProposals,
  PROPOSED_TOPIC,
} from "./proposals";
import type { Ready } from "../pot/use-pot";
import { readLogsBack } from "../money/wallet";

/**
 * How far back a Council's proposals are looked for: about a week of blocks, in pieces a wallet's node accepts. The
 * same window the seat holder's waiting list uses (`council/WaitingActions.tsx`).
 */
const WAITING_WINDOW = 50_000;

const asWhole = (value: unknown): number => {
  if (typeof value !== "bigint" && typeof value !== "number") return 0;
  return Number(value);
};

/** The Council's own record of a proposal: when it was proposed (0 when it is gone), its seat generation, and its agreements. */
async function proposalState(
  read: ReadCall,
  council: string,
  id: string,
): Promise<{ at: number; generation: number; mask: number } | null> {
  const answer = await read(
    council,
    encodeCall(COUNCIL_ABI, "proposals", [id]),
  );
  const [at, generation, mask] = decodeReturn(COUNCIL_ABI, "proposals", answer);
  return {
    at: asWhole(at),
    generation: asWhole(generation),
    mask: asWhole(mask),
  };
}

/** What is waiting in the Council now. Throws when the chain cannot be read: nothing is decided on a guess. */
export async function readCouncilWaiting(
  ready: Ready,
  council: string,
): Promise<{ waiting: CouncilProposal[]; complete: boolean }> {
  const { wallet, read } = ready;
  const to = await wallet.blockNumber();
  const found = await readLogsBack(
    wallet,
    { address: council, topics: [PROPOSED_TOPIC] },
    { from: Math.max(0, to - WAITING_WINDOW), to },
  );
  const [ttlWord] = decodeReturn(
    COUNCIL_ABI,
    "PROPOSAL_TTL",
    await read(council, encodeCall(COUNCIL_ABI, "PROPOSAL_TTL", [])),
  );
  const [generationWord] = decodeReturn(
    COUNCIL_ABI,
    "generation",
    await read(council, encodeCall(COUNCIL_ABI, "generation", [])),
  );
  const ttl = asWhole(ttlWord);
  const generation = asWhole(generationWord);
  // The chain's own clock where the sender can say it (a browser clock can differ from a test chain's).
  let now = Math.floor(Date.now() / 1000);
  if (wallet.blockTime) {
    try {
      now = await wallet.blockTime("latest");
    } catch {
      // The wall clock is the fallback; a wrong `now` can only make an old proposal read as still waiting.
    }
  }
  const waiting: CouncilProposal[] = [];
  for (const proposal of councilProposals(found.logs, council)) {
    const state = await proposalState(read, council, proposal.id);
    if (
      state &&
      state.mask !== 0 &&
      state.generation === generation &&
      state.at + ttl >= now
    )
      waiting.push(proposal);
  }
  return { waiting, complete: found.complete };
}
