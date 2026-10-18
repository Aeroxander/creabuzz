import { Link } from "@tanstack/react-router";
import { useProjectWork } from "@/features/fleet/use-project-work";
import { useUserNames } from "@/features/profiles/use-profiles";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { Launch } from "../models";
import { useChallengeLock } from "../use-challenge-lock";
import { hashText } from "../lib/work";

/** The project-first bridge from the next delivery to work, people, agents and money. */
export function ProjectDeliveryOverview({
  launch,
  dao,
  onOpen,
}: {
  launch: Launch;
  dao: string | null;
  onOpen: (target: "milestones" | "work" | "agents" | "treasury") => void;
}) {
  const tasks = useProjectWork(launch.record);
  const lock = useChallengeLock(dao);
  const planned = launch.record.unlocks?.milestones ?? [];
  const next = lock.data?.milestones.find((m) => m.phase !== "stood");
  const milestone = next
    ? planned.find(
        (p) => hashText(p.label.trim()).toLowerCase() === next.checkHash,
      )?.label
    : null;
  const loaded = tasks.data?.tasks ?? [];
  const active = loaded.filter(
    (t) => !["done", "closed", "cancelled"].includes(t.status),
  );
  const prioritized = [...active].sort(
    (a, b) =>
      Number(b.status === "needs_approval") -
        Number(a.status === "needs_approval") ||
      (a.due ?? Infinity) - (b.due ?? Infinity),
  );
  const nameOf = useUserNames([
    ...launch.record.team.map((t) => t.pubkey),
    ...loaded.flatMap((t) => (t.linkedBy ? [t.linkedBy] : [])),
    ...loaded.flatMap((t) => (t.assignee ? [t.assignee] : [])),
  ]);
  const host = new URL(relayWsUrl()).host;
  return (
    <Card className="p-4" data-testid="project-delivery-overview">
      <p className="text-xs font-semibold text-primary-ink">
        Building together
      </p>
      <h2 className="mt-1 break-words text-lg font-bold">
        {milestone ?? "The next delivery"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {launch.record.pitch}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {planned.length ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpen("milestones")}
          >
            Milestone evidence & unlocks
          </Button>
        ) : null}
        {dao ? (
          <Button size="sm" variant="outline" onClick={() => onOpen("work")}>
            Work budgets & claims
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => onOpen("agents")}>
          People & agents
        </Button>
        {dao ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpen("treasury")}
          >
            Money & spending authority
          </Button>
        ) : null}
      </div>
      {dao && planned.length && (lock.isPending || lock.isError) ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {lock.isError
            ? "The milestone state could not be read. Open the milestone view to retry."
            : "Reading the next milestone from the chain…"}
        </p>
      ) : null}
      <h3 className="mt-4 text-sm font-semibold">Team-recorded work</h3>
      {tasks.isPending ? (
        <p className="mt-2 text-sm">Reading linked work…</p>
      ) : null}
      {tasks.isError || tasks.data?.incomplete ? (
        <p
          className="mt-2 text-sm text-amber-800 dark:text-amber-200"
          role="status"
        >
          Some linked channels could not be read. Private work remains visible
          only to its members.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void tasks.refetch()}
          >
            Retry work
          </Button>
        </p>
      ) : null}
      {tasks.isSuccess && !tasks.data.incomplete && !active.length ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No active work in the linked records. Create or link a task from the
          workspace Work board.
        </p>
      ) : null}
      <ul className="mt-2 divide-y divide-border">
        {prioritized.slice(0, 5).map((t) => (
          <li
            key={t.key}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 break-words">
              <strong>{t.title}</strong>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t.status === "needs_approval"
                  ? "Needs review"
                  : t.status.replace(/_/g, " ")}{" "}
                · {t.assignee ? nameOf(t.assignee) : "Needs an owner"}
                {t.due
                  ? ` · Due ${new Date(t.due * 1000).toLocaleDateString()}`
                  : ""}
                {t.milestone ? ` · ${t.milestone}` : ""}
                {t.delivery?.claim
                  ? ` · Claim reference recorded by ${nameOf(t.linkedBy ?? t.author)}; approval and payment not implied`
                  : ""}
              </span>
            </span>
            <Link
              className="underline"
              to="/c/$host"
              params={{ host }}
              search={{ view: "work", work: t.key }}
            >
              Open task
            </Link>
          </li>
        ))}
      </ul>
      {active.length > 5 || tasks.data?.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          A bounded selection of linked work is shown. Open the workspace for
          more.
        </p>
      ) : null}
      <Link
        className="mt-3 inline-block text-sm underline"
        to="/c/$host"
        params={{ host }}
        search={{ view: "work" }}
      >
        Open workspace Work board
      </Link>
      <p className="mt-2 text-xs text-muted-foreground">
        This overview uses team-signed task records. Other participants’ task
        updates remain on the workspace board. Work status does not authorize
        payment; claims and team-token unlocks follow their own review rules.
      </p>
    </Card>
  );
}
