/**
 * The helper that runs in this browser tab: start it (as the generic assistant
 * or as one of the project's named helpers), stop it, and put it in its seat.
 *
 * A project from a template has a seat per helper, vacant until one takes it.
 * Starting a helper from a seat reads that helper's description from the
 * server, runs it under its own name and prompt, and then has the project's
 * owner (you) sign the record that puts it in the seat, so the organization
 * chart, its limits and the rest of the team see it. If the seat cannot be
 * filled the helper still runs; the screen says so instead of hiding it.
 *
 * A tab runs one helper at a time. Starting another stops the first and
 * empties its seat, so a seat never claims a helper that has moved on.
 */

import { useCallback, useEffect, useState } from "react";

import type { Channel } from "@/features/channels/use-channels";
import { getAgentPubkey } from "@/shared/lib/agent-identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { type AgentLifecycleState, getBrowserAgent } from "./browser-agent";
import { type HelperSeat, seatUpdate } from "./lib/helper-seats";
import { pickPersona, type TabPersona } from "./lib/persona-mention";
import { useOrgChart } from "./use-org-chart";

const KIND_PERSONA = 30175;

/** Words for what can go wrong, so a person knows what to do next. */
function startProblem(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.trim() === "" ? "The helper could not start." : text;
}

export interface TabHelper {
  state: AgentLifecycleState;
  /** The project helper running in this tab, or null for the generic assistant. */
  persona: TabPersona | null;
  starting: boolean;
  /** Why starting failed. */
  error: string | null;
  /** The helper started but its seat could not be filled. */
  seatProblem: string | null;
  /** Start the generic assistant, or the helper for `seat`. */
  start: (seat?: HelperSeat | null) => Promise<void>;
  stop: () => void;
}

export function useTabHelper(channels: Channel[]): TabHelper {
  const { byKey } = useOrgChart();
  const [state, setState] = useState<AgentLifecycleState>("stopped");
  const [persona, setPersona] = useState<TabPersona | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seatProblem, setSeatProblem] = useState<string | null>(null);

  useEffect(() => {
    const agent = getBrowserAgent();
    agent.setEvents({ onStateChange: setState });
    setState(agent.getState());
    setPersona(agent.getPersona());
    return () => agent.setEvents({});
  }, []);

  const stop = useCallback(() => {
    getBrowserAgent().stop();
    setError(null);
  }, []);

  const start = useCallback(
    async (seat?: HelperSeat | null) => {
      const agent = getBrowserAgent();
      setStarting(true);
      setError(null);
      setSeatProblem(null);
      try {
        let next: TabPersona | null = null;
        if (seat?.personaId) {
          const records = await queryEvents(relayWsUrl(), {
            kinds: [KIND_PERSONA],
            "#d": [seat.personaId],
            limit: 10,
          });
          next = pickPersona(
            seat.personaId,
            records.map((r) => ({
              created_at: r.created_at,
              tags: r.tags as string[][],
              content: r.content,
            })),
          );
          if (!next) {
            throw new Error(
              "Couldn't read this helper's description from the server, so it can't start yet. Try again in a moment.",
            );
          }
        }
        // One helper per tab: a running one steps aside first.
        if (agent.isRunning()) agent.stop();
        agent.setPersona(next);
        agent.setChannels(channels.map((c) => c.id));
        await agent.start();
        setPersona(next);

        // Put it in its seat, and take it out of any other it held.
        const pubkey = getAgentPubkey();
        const drafts = Object.values(byKey)
          .filter((entry) => entry.kind === "agent_seat")
          .map((entry) => {
            const wanted =
              seat !== null && seat !== undefined && entry.id === seat.nodeId;
            return seatUpdate(entry, pubkey, wanted ? "fill" : "empty");
          })
          .filter((draft) => draft !== null);
        try {
          for (const draft of drafts) {
            await publishAsUser(
              draft,
              "The server did not accept the seat change. Try again.",
            );
          }
        } catch (problem) {
          setSeatProblem(
            `${next?.name ?? "The helper"} is running, but couldn't take its seat: ${startProblem(problem)}`,
          );
        }
      } catch (problem) {
        setError(startProblem(problem));
      } finally {
        setStarting(false);
      }
    },
    [byKey, channels],
  );

  return { state, persona, starting, error, seatProblem, start, stop };
}
