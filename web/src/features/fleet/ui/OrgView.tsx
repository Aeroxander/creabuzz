/**
 * Org view — the community org chart.
 *
 * Two modes, read-only for now:
 * - When `37010` org nodes exist for this community, they render as a tree
 *   of role/team seats with their occupants (humans + agents) under each —
 *   the NIP-ORG org chart.
 * - When none exist yet, it falls back to the flat team grouping over the
 *   agent roster, exactly as before. Communities without an org see no
 *   regression.
 *
 * Editing (publish a `37010`) is the next step, not this one.
 */

import { useMemo, useState } from "react";
import { Users } from "lucide-react";

import { useAgentRoster, type AgentCapabilities } from "../use-agent-roster";
import { useOrgChart } from "../use-org-chart";
import type { OrgTreeNode } from "../lib/index-org";
import { getBrowserAgent } from "../browser-agent";
import { useUserNames } from "@/features/profiles/use-profiles";
import { peekAgentPubkey } from "@/shared/lib/agent-identity";
import { Badge } from "@/shared/ui/badge";
import { PageHeader } from "@/shared/ui/PageHeader";
import { UserAvatar } from "@/shared/ui/UserAvatar";

const TEAM_SUGGESTIONS = [
  "Platform",
  "Research",
  "Docs & Wiki",
  "Support",
  "Ops",
];

function AgentOrgCard({
  agent,
  onTeam,
  userName,
}: {
  agent: AgentCapabilities;
  onTeam: (team: string | null) => void;
  userName: (pubkey: string) => string;
}) {
  const isMine = agent.id === peekAgentPubkey();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.team ?? "");
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-black/10 bg-white p-2.5 dark:border-white/10 dark:bg-white/5">
      <div className="relative shrink-0">
        <UserAvatar
          avatarUrl={null}
          displayName={agent.name}
          size="sm"
          // Offline reads as desaturated, not transparent: half opacity halves
          // the contrast of the initials underneath, which axe flags as
          // serious (a name you cannot read is not a status).
          className={agent.alive ? "" : "grayscale"}
        />
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-white/10 ${
            agent.alive ? "bg-emerald-500" : "bg-black/20 dark:bg-white/20"
          }`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium text-black dark:text-white">
            {agent.name}
          </p>
          {isMine ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-2xs">
              this tab
            </Badge>
          ) : null}
        </div>
        {/* The identity line carries identity, never a repeat of the roster
            name above: a username when the community knows this pubkey, the
            truncated pubkey otherwise, with the full key on hover. */}
        <p
          className="truncate font-mono text-2xs text-black/60 dark:text-white/60"
          title={agent.pubkey}
        >
          {userName(agent.pubkey)}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Badge variant="outline" className="px-1.5 py-0 text-2xs capitalize">
            {agent.runtype}
          </Badge>
          <Badge variant="outline" className="px-1.5 py-0 text-2xs capitalize">
            {agent.status}
          </Badge>
          {editing ? (
            <>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Team name"
                className="w-24 rounded-md border border-input bg-background px-1.5 py-0.5 text-2xs outline-none"
                data-testid={`team-input-${agent.id.slice(0, 6)}`}
              />
              <button
                type="button"
                onClick={() => {
                  onTeam(draft || null);
                  setEditing(false);
                }}
                className="rounded-md bg-black px-2 py-0.5 text-2xs font-medium text-white dark:bg-white dark:text-black"
              >
                Save
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-full border border-black/10 bg-background px-2 py-0.5 text-2xs text-black/60 hover:bg-black/5 dark:border-white/10 dark:text-white/60 dark:hover:bg-white/10"
              title={
                isMine
                  ? "Set this tab agent's team"
                  : "Team shown here is announced by the agent"
              }
              data-testid={`team-edit-${agent.id.slice(0, 6)}`}
            >
              {agent.team ?? "Unassigned"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function OrgNodeCard({
  node,
  level,
  userName,
}: {
  node: OrgTreeNode;
  level: number;
  userName: (pubkey: string) => string;
}) {
  const occupants = [...node.entry.holders, ...node.entry.agentSeats];
  return (
    <div style={{ marginLeft: level > 0 ? level * 20 : 0 }}>
      <div className="flex items-start gap-2.5 rounded-lg border border-black/10 bg-white p-2.5 dark:border-white/10 dark:bg-white/5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 shrink-0 text-black/60 dark:text-white/60" />
            <p className="truncate text-sm font-medium text-black dark:text-white">
              {node.entry.name}
            </p>
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-2xs capitalize"
            >
              {node.entry.kind}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-2xs text-black/60 dark:text-white/60">
            {occupants.length} {occupants.length === 1 ? "seat" : "seats"}
          </p>
          {occupants.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {occupants.map((pubkey) => (
                <span
                  key={pubkey}
                  title={pubkey}
                  className="inline-flex items-center gap-1 rounded-full border border-black/10 px-1.5 py-0.5 text-2xs dark:border-white/10"
                >
                  <UserAvatar
                    avatarUrl={null}
                    displayName={userName(pubkey)}
                    size="xs"
                  />
                  <span className="max-w-24 truncate font-mono">
                    {userName(pubkey)}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {node.children.map((child) => (
        <div key={`${child.entry.pubkey}:${child.entry.id}`} className="mt-2">
          <OrgNodeCard node={child} level={level + 1} userName={userName} />
        </div>
      ))}
    </div>
  );
}

/**
 * The NIP-ORG org chart: a tree of role/team seats with their occupants.
 * Read-only for now — structurally identical to the roster fallback's card
 * language (avatar + identity line + badges), so the chart and the fallback
 * read as one surface.
 */
function OrgChartView({
  forest,
  loading,
}: {
  forest: OrgTreeNode[];
  loading: boolean;
}) {
  const pubkeys = useMemo(() => {
    const out = new Set<string>();
    const walk = (node: OrgTreeNode) => {
      for (const p of [...node.entry.holders, ...node.entry.agentSeats]) {
        out.add(p);
      }
      for (const child of node.children) walk(child);
    };
    for (const root of forest) walk(root);
    return [...out];
  }, [forest]);
  // Total nodes, not roots: the header describes the whole chart, and a
  // forest's length alone would under-count every nested team.
  const nodeCount = useMemo(() => {
    const count = (node: OrgTreeNode): number =>
      1 + node.children.reduce((sum, child) => sum + count(child), 0);
    return forest.reduce((sum, root) => sum + count(root), 0);
  }, [forest]);
  // One batched kind-0 read for every seat occupant on the page.
  const userName = useUserNames(pubkeys);
  const seatCount = pubkeys.length;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
      <PageHeader
        title="Org"
        action={
          <span className="text-xs text-black/60 dark:text-white/60">
            {nodeCount} {nodeCount === 1 ? "team" : "teams"} · {seatCount}{" "}
            {seatCount === 1 ? "seat" : "seats"}
          </span>
        }
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {loading && forest.length === 0 ? (
          <p className="text-xs text-black/60 dark:text-white/60">
            Loading org chart…
          </p>
        ) : (
          forest.map((root) => (
            <section key={`${root.entry.pubkey}:${root.entry.id}`}>
              <OrgNodeCard node={root} level={0} userName={userName} />
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function setTeamFn(agent: AgentCapabilities, team: string | null) {
  if (agent.id === peekAgentPubkey()) {
    getBrowserAgent().setTeam(team);
  }
}

/**
 * The pre-org fallback: the fleet grouped by free-text team, exactly as the
 * old OrgView rendered it. Kept verbatim so communities without any `37010`
 * nodes see no regression.
 */
export function OrgView() {
  const { agents, loading } = useAgentRoster();
  const { forest, loading: chartLoading } = useOrgChart();

  // Show the chart as soon as any `37010` node exists; while it is still
  // loading with an empty roster, show the chart shell (the fallback would
  // flash an empty "Unassigned" group first). Once the chart is known-empty,
  // the pre-org roster fallback renders exactly as before.
  return forest.length > 0 || (chartLoading && agents.length === 0) ? (
    <OrgChartView forest={forest} loading={chartLoading} />
  ) : (
    <OrgRosterFallback agents={agents} loading={loading} />
  );
}

function OrgRosterFallback({
  agents,
  loading,
}: {
  agents: AgentCapabilities[];
  loading: boolean;
}) {
  const groups = useMemo(() => {
    const byTeam = new Map<string, AgentCapabilities[]>();
    for (const agent of agents) {
      const team = agent.team ?? "Unassigned";
      byTeam.set(team, [...(byTeam.get(team) ?? []), agent]);
    }
    return [...byTeam.entries()].sort((a, b) =>
      a[0] === "Unassigned"
        ? 1
        : b[0] === "Unassigned"
          ? -1
          : a[0].localeCompare(b[0]),
    );
  }, [agents]);

  // One batched kind-0 read for every roster pubkey on the page.
  const rosterPubkeys = useMemo(() => agents.map((a) => a.pubkey), [agents]);
  const userName = useUserNames(rosterPubkeys);

  const online = agents.filter((a) => a.alive).length;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
      <PageHeader
        title="Org"
        action={
          <span className="text-xs text-black/60 dark:text-white/60">
            {agents.length} agents · {online} online · {groups.length} teams
          </span>
        }
      />

      {TEAM_SUGGESTIONS.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-black/60 dark:text-white/60">
            Suggest a team for this tab agent:
          </span>
          {TEAM_SUGGESTIONS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => getBrowserAgent().setTeam(t)}
              className="rounded-full border border-black/10 bg-white px-2.5 py-1 text-xs text-black/70 hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
              data-testid={`team-suggest-${t.split(" ")[0].toLowerCase()}`}
            >
              {t}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {loading && agents.length === 0 ? (
          <p className="text-xs text-black/60 dark:text-white/60">
            Loading roster…
          </p>
        ) : (
          groups.map(([team, members]) => (
            <section key={team}>
              <div className="mb-1.5 flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-black/60 dark:text-white/60" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-black/55 dark:text-white/55">
                  {team}
                </h3>
                <span className="text-2xs text-black/60 dark:text-white/60">
                  {members.length}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {members.map((agent) => (
                  <AgentOrgCard
                    key={agent.id}
                    agent={agent}
                    onTeam={(t) => setTeamFn(agent, t)}
                    userName={userName}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
