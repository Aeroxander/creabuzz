/**
 * What the Back sheet says about tasks that are planned (plan section 5.10): one line from the record's rows, handed to the
 * sheet as a plain value. The chain's own quote is what the price is made of; this line only tells a person that money may
 * be set aside soon, and that leaving is open.
 */
import type { ProjectNumbers } from "../money/numbers";
import { nowOf, phaseOf } from "../tasks/chain/state";
import { backPlannedWords } from "../money/copy";

/** The line about planned tasks, or null when the record shows none (or has no queue). */
export function plannedBackLine(numbers: ProjectNumbers): string | null {
  const queue =
    typeof numbers.tasks === "object" && numbers.tasks ? numbers.tasks : null;
  if (!queue) return null;
  const now = nowOf(numbers.asOf.time);
  const rows = queue.list.filter((row) => {
    const phase = phaseOf(row, now, numbers.windDown?.at ?? null);
    return phase === "notice" || phase === "open";
  });
  if (rows.length === 0) return null;
  const waiting = rows.filter((row) => row.noticeEnd > now);
  return backPlannedWords({
    max: rows.reduce((sum, row) => sum + row.maxDollars, 0n),
    count: rows.length,
    from:
      waiting.length === rows.length
        ? Math.min(...waiting.map((row) => row.noticeEnd))
        : null,
  });
}
