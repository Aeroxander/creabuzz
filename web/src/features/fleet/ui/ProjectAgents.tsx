import {
  useBudgets,
  describeBudgetLimits,
} from "@/features/budgets/use-budgets";
import { ENFORCEMENT_LABEL } from "@/features/budgets/lib/budgetForm";
import { Link } from "@tanstack/react-router";
import type { Launch } from "@/features/launchpad/models";
import { useUserNames } from "@/features/profiles/use-profiles";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { useAgentRoster } from "../use-agent-roster";
import { useOrgChart } from "../use-org-chart";
import { useProjectWork } from "../use-project-work";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

/** Project-scoped supervision; an agent's announcement is not evidence of spending authority. */
export function ProjectAgents({ launch }: { launch: Launch }) {
  const budgets = useBudgets();
  const roster = useAgentRoster();
  const org = useOrgChart();
  const work = useProjectWork(launch.record);
  // A stranger's seat naming this project does not become its org. Use the project's own author for role provenance.
  const seats = Object.values(org.byKey).filter(
    (n) => n.pubkey === launch.record.author && n.kind === "agent_seat",
  );
  const known = new Set([
    ...seats.flatMap((n) => n.agentSeats),
    ...(launch.record.agent ? [launch.record.agent] : []),
    ...(work.data?.tasks.flatMap((t) => (t.assignee ? [t.assignee] : [])) ??
      []),
  ]);
  const agents = roster.agents.filter((a) => known.has(a.pubkey));
  const people = [
    ...new Set([
      ...seats.flatMap((s) => [s.pubkey, ...s.holders]),
      ...agents.map((a) => a.pubkey),
    ]),
  ];
  const nameOf = useUserNames(people);
  const host = new URL(relayWsUrl()).host;
  return (
    <section
      className="space-y-3"
      aria-label="Project agents"
      data-testid="project-agents"
    >
      <Card className="p-4">
        <h2 className="text-lg font-bold">People & agents</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          See project work and the founder-managed community helper seats. Seats
          belong to the community; only team-signed tasks count as project work
          here. Other participants’ updates remain on the workspace board.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link
            className="text-sm underline"
            to="/c/$host"
            params={{ host }}
            search={{ view: "org" }}
          >
            Manage roles, budgets & emergency stops
          </Link>
          <Link
            className="text-sm underline"
            to="/c/$host"
            params={{ host }}
            search={{ view: "fleet" }}
          >
            Run or stop your tab helper
          </Link>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          A seat or task assignment does not grant wallet authority. Budget
          controls distinguish recorded limits from enforced limits. Usage in AI
          helpers covers this browser's helper, not all project agents.
        </p>
      </Card>
      {roster.loadError ||
      org.loadError ||
      work.isError ||
      work.data?.incomplete ? (
        <Card className="p-3 text-sm" role="status">
          Some agent, role or work records could not be read. Keep unknown
          activity and authority unverified.{" "}
          <Button
            size="sm"
            variant="outline"
            disabled={roster.loading || org.loading || work.isFetching}
            onClick={() => {
              roster.reload();
              org.reload();
              void work.refetch();
            }}
          >
            Reload records
          </Button>
        </Card>
      ) : null}
      {roster.loading || org.loading || work.isPending ? (
        <p className="text-sm">Reading agents and assigned work…</p>
      ) : null}
      {!roster.loading &&
      !org.loading &&
      !roster.loadError &&
      !org.loadError &&
      work.isSuccess &&
      !work.data.incomplete &&
      !agents.length ? (
        <p className="text-sm text-muted-foreground">
          No announced helpers are linked to this project's seats or tasks yet.
          Open role management to give a helper a seat.
        </p>
      ) : null}
      {agents.map((agent) => {
        const roles = seats.filter((s) => s.agentSeats.includes(agent.pubkey));
        const tasks =
          work.data?.tasks.filter(
            (t) =>
              t.assignee === agent.pubkey &&
              !["done", "closed", "cancelled"].includes(t.status),
          ) ?? [];
        const waiting = tasks.filter((t) => t.status === "needs_approval");
        const recordedBudgets = budgets.budgets.filter(
          (b) => b.author === launch.record.author,
        );
        const ownBudgets = recordedBudgets.filter(
          (b) => b.subject === agent.pubkey,
        );
        const applicable = ownBudgets.length
          ? ownBudgets
          : recordedBudgets.filter((b) => b.subject === "*");
        return (
          <Card
            key={`${agent.pubkey}:${agent.id}`}
            className="p-4"
            data-testid="project-agent-card"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 flex-1 break-words font-semibold">
                {agent.name}
              </h3>
              <span className="text-xs text-muted-foreground">
                {agent.alive ? agent.status : "No recent heartbeat"}
              </span>
            </div>
            <p className="mt-1 text-sm">
              {roles.length
                ? roles
                    .map((r) => `${r.name} · managed by ${nameOf(r.pubkey)}`)
                    .join("; ")
                : "Assigned work here; no project-authored seat was found."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Last announcement {new Date(agent.updatedAt).toLocaleString()} ·{" "}
              {waiting.length} awaiting review · {tasks.length} active tasks
            </p>
            <ul className="mt-3 space-y-2">
              {tasks.slice(0, 5).map((task) => (
                <li key={task.key} className="text-sm">
                  <Link
                    className="underline"
                    to="/c/$host"
                    params={{ host }}
                    search={{ view: "work", work: task.key }}
                  >
                    {task.title}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {task.status.replace(/_/g, " ")}
                  </span>
                  {task.delivery?.output ? (
                    <a
                      className="ml-2 underline"
                      href={task.delivery.output}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Output
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
            {tasks.length > 5 ? (
              <p className="mt-2 text-xs">
                More assigned work is available in the workspace.
              </p>
            ) : null}
            <div className="mt-3 text-xs" data-testid="agent-budget-context">
              <h4 className="font-semibold">
                Founder-recorded budget & approval limits
              </h4>
              {budgets.loading ? (
                <p>Reading limits…</p>
              ) : budgets.error ? (
                <p role="status">
                  Could not read limits.{" "}
                  <Button size="sm" variant="outline" onClick={budgets.reload}>
                    Retry budgets
                  </Button>
                </p>
              ) : applicable.length ? (
                <ul className="mt-1 space-y-1">
                  {applicable.flatMap((b) =>
                    describeBudgetLimits({
                      limits: b.limits,
                      window: b.window,
                      onchain: b.onchain,
                    }).map((row) => (
                      <li key={`${b.id}:${row.key}`}>
                        {row.text} ·{" "}
                        {row.enforcement === "onchain"
                          ? "Onchain binding recorded; allowance not verified here"
                          : ENFORCEMENT_LABEL[row.enforcement]}
                        {b.subject === "*" ? " · Community default" : ""}
                      </li>
                    )),
                  )}
                </ul>
              ) : (
                <p>
                  No applicable limit found in the latest budget records. This
                  does not establish unlimited authority.
                </p>
              )}
              <p className="mt-1 text-muted-foreground">
                These are recorded limits, not measured spending or a live
                allowance balance.
              </p>
            </div>
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer">
                Announced tools and recorded role scope
              </summary>
              <p className="mt-2 break-words">
                Tools: {agent.tools.join(", ") || "Not announced"}. These
                announcements do not prove permission.
              </p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words">
                {roles.length
                  ? JSON.stringify(
                      roles.map((r) => ({ seat: r.name, scope: r.scope })),
                      null,
                      2,
                    )
                  : "No project-authored role scope recorded."}
              </pre>
            </details>
          </Card>
        );
      })}
    </section>
  );
}
