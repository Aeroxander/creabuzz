import { Chip } from "@/shared/ui/chip";
import { Meter } from "@/shared/ui/meter";

import { formatAtomic } from "../lib/amounts";
import { idLabel } from "../lib/work";
import { shortNameBeside, workTitle } from "../lib/work-titles";
import type { WorkBounties } from "../lib/work-bounty";
import type { MandateView, ProjectView } from "../lib/work-read";
import { Person } from "./Face";
import { WorkAreaBounties } from "./WorkAreaBounties";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });

/** Why a work area of an open budget takes no work now: its budget closed, its time ran out, or it gave all it had. */
function endedReason(
  mandate: MandateView,
  project: ProjectView,
  now: number,
): string {
  if (mandate.closed) return "Budget closed";
  if (project.record.expiresAt <= now || mandate.expiresAt <= now)
    return "Ended";
  return "All awarded";
}

/**
 * A budget's work areas, as far as Open work does not already show them: those not taking work now, each with why and
 * with any money people put behind it (its refund or payment stays reachable here), or a milestone panel's milestones.
 * When every area is open, one line says where they are.
 */
export function BudgetWorkAreas({
  mandate,
  open,
  bounties,
  chainId,
  chainTime,
  wallet,
  gate,
  busy,
  onSend,
  labelOf,
  money,
}: {
  mandate: MandateView;
  /** The areas Open work lists, as `budget:area`, lower case. */
  open: ReadonlySet<string>;
  bounties: WorkBounties | undefined;
  chainId: string | null;
  chainTime: number;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
  labelOf: (address: string) => string;
  /** The budget's money, written in its currency. */
  money: (units: bigint) => string;
}) {
  if (mandate.projects.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No work area has been approved in this budget yet.
      </p>
    );
  }
  const key = (project: ProjectView) =>
    `${mandate.address.toLowerCase()}:${project.id.toLowerCase()}`;
  const listed = mandate.isMilestonePanel
    ? mandate.projects
    : mandate.projects.filter((project) => !open.has(key(project)));
  const openCount = mandate.projects.length - listed.length;
  // Every area is on the Open work card above: nothing more to list here.
  if (listed.length === 0) return null;
  return (
    <>
      <h4 className="mt-3 text-sm font-semibold">
        {mandate.isMilestonePanel ? "Milestones" : "Not taking work now"}
      </h4>
      {openCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {openCount === 1
            ? "1 more is under Open work."
            : `${openCount} more are under Open work.`}
        </p>
      ) : null}
      <ul
        className="mt-2 flex flex-col gap-2 text-sm"
        data-testid={
          mandate.isMilestonePanel ? "work-milestones" : "work-projects-ended"
        }
      >
        {listed.map((project) => (
          <li
            className="rounded-xl border border-border/60 p-3"
            data-area={idLabel(project.id)}
            key={project.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2">
                {/* The short name the chain keys it by, quietly beside the title: it is what a submission names. */}
                <span className="font-medium">
                  {workTitle(project.id)}
                  {shortNameBeside(project.id, workTitle(project.id)) ? (
                    <span className="font-mono text-xs font-normal text-muted-foreground">
                      {" "}
                      {shortNameBeside(project.id, workTitle(project.id))}
                    </span>
                  ) : null}
                </span>
                {mandate.isMilestonePanel ? null : (
                  <Chip>{endedReason(mandate, project, chainTime)}</Chip>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                <Person label={labelOf(project.record.manager)} />
              </span>
            </div>
            {project.record.shareBudget > 0n ? (
              <div className="mt-2">
                <Meter
                  label={`${workTitle(project.id)}: Shares awarded`}
                  max={project.record.shareBudget}
                  value={project.record.sharesAwarded}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {shares(project.record.sharesAwarded)} of{" "}
                  {shares(project.record.shareBudget)} Shares awarded
                </p>
              </div>
            ) : null}
            {project.record.budget > 0n ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {money(project.record.reserved)} of{" "}
                {money(project.record.budget)} reserved
              </p>
            ) : null}
            {mandate.isMilestonePanel ? null : (
              <WorkAreaBounties
                busy={busy}
                chainId={chainId}
                chainTime={chainTime}
                gate={gate}
                labelOf={labelOf}
                mandate={mandate}
                onSend={onSend}
                project={project}
                read={bounties}
                wallet={wallet}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
