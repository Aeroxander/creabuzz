import { publishAgentSeat } from "./hooks";
import { SeatNotFoundError } from "./lib/orgPublish";

/** Node id of the vacant seat a template creates for a persona. */
export function templateSeatId(personaId: string): string {
  return `seat-${personaId}`;
}

/**
 * Fill the org seat a template made for `personaId` with the freshly deployed
 * agent. `no-seat` means this persona has no seat among your nodes (a persona
 * not from a template, or someone else's org) — expected, not an error. Any
 * other failure throws so the caller can tell the user; the agent is already
 * covered by the community default budget either way.
 */
export async function seatDeployedAgent(
  personaId: string,
  agentPubkey: string,
): Promise<"seated" | "already" | "no-seat"> {
  try {
    const changed = await publishAgentSeat({
      dtag: templateSeatId(personaId),
      agentPubkey,
    });
    return changed ? "seated" : "already";
  } catch (error) {
    if (error instanceof SeatNotFoundError) return "no-seat";
    throw error;
  }
}
