/**
 * Channel templates for the web create-channel flow.
 *
 * A template pre-fills the channel defaults (type, visibility, topic) and
 * declares which agents join the channel as bots. Seats resolve against the
 * community's agent roster (kind:44010 capability announcements) at creation
 * time — web has no local agent runtime, so templates here deliberately cover
 * the pure-Nostr part of desktop's template apply: channel shape + membership.
 *
 * Seat model:
 * - `{ type: "all-agents" }` — every agent in the roster.
 * - `{ type: "team", teamName }` — every roster agent on that team.
 * - `{ type: "agent", agentId }` — one roster agent by its stable id.
 */

import type {
  ChannelTypeChoice,
  ChannelVisibilityChoice,
} from "./channel-create-events";

export type TemplateSeat =
  | { type: "all-agents" }
  | { type: "team"; teamName: string }
  | { type: "agent"; agentId: string };

export type ChannelTemplate = {
  id: string;
  name: string;
  /** One-line plain-language description shown under the picker. */
  summary: string;
  channelType: ChannelTypeChoice;
  visibility: ChannelVisibilityChoice;
  /** Pre-filled topic; the user can edit it. */
  topic: string;
  seats: readonly TemplateSeat[];
};

/** A roster agent as the template planner sees it. */
export type RosterAgent = {
  /** Stable agent id (the announcement's `d` tag). */
  id: string;
  /** Author pubkey of the announcement — the identity added to the channel. */
  pubkey: string;
  name: string;
  /** Team name from the announcement, or null for unteamed agents. */
  team: string | null;
};

export const CHANNEL_TEMPLATES: readonly ChannelTemplate[] = [
  {
    id: "blank",
    name: "Blank channel",
    summary: "Start from scratch — pick members yourself.",
    channelType: "stream",
    visibility: "open",
    topic: "",
    seats: [],
  },
  {
    id: "agent-workspace",
    name: "Agent workspace",
    summary: "A channel where every agent in your community is a member.",
    channelType: "stream",
    visibility: "open",
    topic: "Working session with the community's agents.",
    seats: [{ type: "all-agents" }],
  },
  {
    id: "team-room",
    name: "Team room",
    summary: "A private channel for one team's agents.",
    channelType: "stream",
    visibility: "private",
    topic: "Team coordination.",
    seats: [{ type: "team", teamName: "" }],
  },
];

export function getChannelTemplate(id: string): ChannelTemplate | undefined {
  return CHANNEL_TEMPLATES.find((t) => t.id === id);
}

export type PlannedAttachment = {
  pubkey: string;
  name: string;
  /** Agents attach as bots, matching desktop's channel-managed agents. */
  role: "bot";
};

/**
 * Resolve a template's seats against the current roster.
 *
 * `teamName` seats resolve against `preferredTeamName` when the template left
 * the team blank (the "Team room" template — the dialog supplies the team the
 * user picked). Unresolvable seats are reported, never silently dropped.
 */
export function planTemplateAttachments(
  template: ChannelTemplate,
  agents: readonly RosterAgent[],
  options: { preferredTeamName?: string } = {},
): { attachments: PlannedAttachment[]; unresolvedSeats: string[] } {
  const byPubkey = new Map<string, PlannedAttachment>();
  const unresolvedSeats: string[] = [];

  const add = (agent: RosterAgent) => {
    const pubkey = agent.pubkey.toLowerCase();
    if (!byPubkey.has(pubkey)) {
      byPubkey.set(pubkey, {
        pubkey,
        name: agent.name,
        role: "bot",
      });
    }
  };

  for (const seat of template.seats) {
    if (seat.type === "all-agents") {
      if (agents.length === 0) {
        unresolvedSeats.push("no agents found in this community");
        continue;
      }
      for (const agent of agents) add(agent);
      continue;
    }
    if (seat.type === "team") {
      const teamName = seat.teamName || options.preferredTeamName || "";
      const members = agents.filter((a) => a.team === teamName);
      if (!teamName || members.length === 0) {
        unresolvedSeats.push(
          teamName
            ? `no agents found for team "${teamName}"`
            : "no team picked",
        );
        continue;
      }
      for (const agent of members) add(agent);
      continue;
    }
    const agent = agents.find((a) => a.id === seat.agentId);
    if (!agent) {
      unresolvedSeats.push(`agent "${seat.agentId}" not found`);
      continue;
    }
    add(agent);
  }

  return { attachments: [...byPubkey.values()], unresolvedSeats };
}

/** Group roster agents by team name (null-team agents land under ""). */
export function groupAgentsByTeam(
  agents: readonly RosterAgent[],
): Map<string, RosterAgent[]> {
  const groups = new Map<string, RosterAgent[]>();
  for (const agent of agents) {
    const key = agent.team ?? "";
    const list = groups.get(key);
    if (list) {
      list.push(agent);
    } else {
      groups.set(key, [agent]);
    }
  }
  return groups;
}
