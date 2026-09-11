/**
 * Org view — the fleet grouped by team.
 */

import { useMemo, useState } from "react";
import { Users } from "lucide-react";

import { useAgentRoster, type AgentCapabilities } from "../use-agent-roster";
import { getBrowserAgent } from "../browser-agent";
import { getAgentPubkey } from "@/shared/lib/agent-identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
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
}: {
  agent: AgentCapabilities;
  onTeam: (team: string | null) => void;
}) {
  const isMine = agent.id === getAgentPubkey();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.team ?? "");
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-black/10 bg-white p-2.5 dark:border-white/10 dark:bg-white/5">
      <div className="relative shrink-0">
        <UserAvatar
          avatarUrl={null}
          displayName={agent.name}
          size="sm"
          className={agent.alive ? "" : "opacity-50"}
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
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              this tab
            </Badge>
          ) : null}
        </div>
        <p className="truncate font-mono text-[10px] text-black/60 dark:text-white/60">
          {truncatePubkey(agent.pubkey)}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[10px] capitalize"
          >
            {agent.runtype}
          </Badge>
          <Badge
            variant="outline"
            className="px-1.5 py-0 text-[10px] capitalize"
          >
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

export function OrgView() {
  const { agents, loading } = useAgentRoster();

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

  const online = agents.filter((a) => a.alive).length;

  const setTeam = (agent: AgentCapabilities, team: string | null) => {
    if (agent.id === getAgentPubkey()) {
      getBrowserAgent().setTeam(team);
    }
  };

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
                    onTeam={(t) => setTeam(agent, t)}
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
