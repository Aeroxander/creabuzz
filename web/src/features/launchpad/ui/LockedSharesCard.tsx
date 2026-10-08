import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { formatAtomic } from "../lib/amounts";
import { encodeUnlock } from "../lib/milestone-lock";
import { hashText } from "../lib/work";
import type { Launch } from "../models";
import type { MilestoneLockState } from "../use-work";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });

/**
 * The team Shares a wallet holds but cannot sell or take out of the DAO yet, milestone by milestone. They are the
 * wallet's own and count when the DAO votes; each milestone lifts the hold on its part once the reviewers have
 * approved the claim for it. The words of a milestone are what its claim must state as its check, so they are shown
 * exactly (the chain keeps only their fingerprint; the launch record keeps the words).
 */
export function LockedSharesCard({
  lock,
  launch,
  wallet,
  gate,
  busy,
  onSend,
}: {
  lock: MilestoneLockState;
  launch: Launch;
  wallet: string;
  gate: string | null;
  busy: string | null;
  /** Sends one transaction; resolves true once it landed. */
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const { view, offers } = lock;
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
        {view.tranches.map((tranche) => {
          const label = words.get(tranche.checkHash.toLowerCase());
          const offer = offers.find((o) => o.tranche.index === tranche.index);
          const key = `unlock-${tranche.index}`;
          return (
            <li
              className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/10"
              data-testid={`locked-shares-milestone-${tranche.index}`}
              key={tranche.index}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  Milestone {tranche.index + 1}: {shares(tranche.amount)} Shares
                </span>
                <span className="text-xs text-muted-foreground">
                  {tranche.unlocked
                    ? "Unlocked"
                    : tranche.forfeited
                      ? "Given up"
                      : "Locked"}
                </span>
              </div>
              {label ? (
                <p className="mt-1 text-muted-foreground">
                  Judged by: <code>{label}</code>
                </p>
              ) : null}
              {tranche.unlocked || tranche.forfeited ? null : offer ? (
                <div className="mt-2">
                  <p className="text-muted-foreground">
                    The reviewers approved your claim for this milestone.
                  </p>
                  <Button
                    aria-busy={busy === key}
                    aria-label={`Unlock milestone ${tranche.index + 1}`}
                    className="mt-1"
                    data-testid={`locked-shares-unlock-${tranche.index}`}
                    disabled={busy !== null || gate !== null}
                    onClick={() =>
                      void onSend(
                        key,
                        view.lock,
                        encodeUnlock(
                          wallet,
                          tranche.index,
                          offer.mandate,
                          offer.claimId,
                        ),
                      )
                    }
                    size="sm"
                    type="button"
                  >
                    {busy === key ? "Unlocking…" : "Unlock"}
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-muted-foreground">
                  File a claim below in a work budget, with
                  {label
                    ? " these exact words"
                    : " this milestone's exact words"}{" "}
                  as its check. Once the reviewers approve it and the waiting
                  period ends, you can unlock it here.
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
