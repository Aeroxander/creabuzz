import type { WorkSnapshot } from "@creaton/core/launchpad/workRead.ts";

/**
 * Says out loud that the DAO's answer about which budget is its milestone panel
 * did not arrive.
 *
 * `WorkSnapshot.milestonePanelUnreadable` is set when the factory question got
 * no answer (a timeout, an unreachable or busy node, a reply that is not an
 * address). Every budget then reads `isMilestonePanel: false` because we do not
 * know — not because they are all ordinary budgets — so the cards below would
 * label the panel as "Not taking work now" without this note.
 */
export function PanelUnreadableNote({
  work,
}: {
  work: WorkSnapshot | undefined;
}) {
  if (!work?.milestonePanelUnreadable) return null;
  return (
    <p
      className="mt-2 text-sm text-muted-foreground"
      data-testid="work-panel-unreadable"
      role="status"
    >
      Couldn&apos;t read which of this project&apos;s budgets is the milestone
      panel, so the cards below may show it as an ordinary budget. Reload to try
      again.
    </p>
  );
}
