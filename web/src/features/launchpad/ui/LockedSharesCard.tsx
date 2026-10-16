import { Card } from "@/shared/ui/card";
import { formatAtomic } from "../lib/amounts";
import { hashText } from "../lib/work";
import type { WorkSnapshot } from "../lib/work-read";
import type { Launch } from "../models";
import type { MilestoneLockState } from "../use-work";
import { MilestoneRow } from "./MilestoneRow";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });

/**
 * The team Shares a wallet holds but cannot sell or take out of the DAO yet, milestone by milestone. They are the
 * wallet's own and count when the DAO votes; each milestone lifts the hold on its part once the reviewers have
 * approved the claim for it. The words of a milestone are what its claim must state as its check, so they are shown
 * exactly (the chain keeps only their fingerprint; the launch record keeps the words).
 */
export function LockedSharesCard({
  lock,
  work,
  launch,
  wallet,
  gate,
  busy,
  onSend,
}: {
  lock: MilestoneLockState;
  /** The DAO's work, where the milestone panel and its claims are read. */
  work: WorkSnapshot | undefined;
  launch: Launch;
  wallet: string;
  gate: string | null;
  busy: string | null;
  /** Sends one transaction; resolves true once it landed. */
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const { view } = lock;
  const words = new Map(
    (launch.record.unlocks?.milestones ?? []).map((m) => [
      hashText(m.label).toLowerCase(),
      m.label.trim(),
    ]),
  );
  const allClear = view.locked === 0n;

  return (
    <Card className="p-4" data-testid="locked-shares">
      <h3 className="text-sm font-semibold">Your team Shares</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        These Shares are yours and count when the DAO votes. The part tied to a
        milestone cannot be sold or taken out of the DAO until that milestone is
        reached.
      </p>
      <p className="mt-2 text-sm" data-testid="locked-shares-total">
        {allClear
          ? "Nothing is locked any more."
          : `${shares(view.locked)} Shares are still locked.`}
      </p>
      <ol aria-label="Milestones" className="mt-2 flex flex-col gap-2">
        {view.tranches.map((tranche) => (
          <MilestoneRow
            busy={busy}
            gate={gate}
            key={tranche.index}
            launch={launch}
            lock={view.lock}
            onSend={onSend}
            tranche={tranche}
            wallet={wallet}
            words={words.get(tranche.checkHash.toLowerCase())}
            work={work}
          />
        ))}
      </ol>
    </Card>
  );
}
