/**
 * The words the Trading card says about rounds it did not look at: the look-back limit, the button that checks the next
 * block of older rounds, and what each outcome of that check says. Split from `trading-copy.ts`, which may not grow.
 */

/**
 * Said when the card did not look at every earlier round. A claim never expires,
 * so what an older round owes is still the wallet's; the line names the ids not
 * yet looked at (they are always the oldest, 1 up to `unchecked`) and the card
 * offers {@link checkOlderLabel} to look at the next block.
 */
export function earlierLimitLine(
  checked: number,
  unchecked: bigint,
): string | null {
  if (unchecked <= 0n) return null;
  const left = unchecked === 1n ? "Round 1 is" : `Rounds 1 to ${unchecked} are`;
  return `This page has checked your last ${checked} rounds. ${left} not checked yet. Anything an older round owes you is still yours.`;
}

/** The button that checks the next block of older rounds. */
export function checkOlderLabel(checking: boolean): string {
  return checking ? "Checking…" : "Check older rounds";
}

/**
 * Said once the oldest round is checked. The reassurance that nothing is waiting is only true when no earlier round
 * owes the wallet (`owed`); otherwise it would contradict the Collect row shown beside it.
 */
export function earlierAllCheckedLine(owed: boolean): string {
  return owed
    ? "Every round has been checked."
    : "Every round has been checked. Nothing older is waiting for you.";
}

/** Said when a block of older rounds could not be read, so it is not mistaken for rounds with nothing in them. */
export function olderFailedLine(): string {
  return "We could not check the older rounds just now. Try again.";
}
