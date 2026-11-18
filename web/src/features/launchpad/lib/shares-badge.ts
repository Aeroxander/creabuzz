/**
 * "2.1% of Shares": how much of a DAO's voting Shares a person holds, as a
 * short label to put beside their name in a discussion about one of its
 * decisions. Alias-free; `shares-badge.test.mjs` drives it under `node --test`.
 *
 * Nothing is shown for someone who holds none, or when either number could not
 * be read: the label never guesses, and its absence says nothing.
 */

/** The label, or null when there is nothing true to say. */
export function sharesBadge(
  balance: bigint | null,
  totalSupply: bigint | null,
): string | null {
  if (balance === null || totalSupply === null) return null;
  if (balance <= 0n || totalSupply <= 0n || balance > totalSupply) return null;
  // Basis points (1/100 of a percent), rounded down; below one of them, say so.
  const bps = (balance * 10_000n) / totalSupply;
  if (bps === 0n) return "<0.01% of Shares";
  const whole = bps / 100n;
  const fraction = bps % 100n;
  const text =
    fraction === 0n
      ? `${whole}`
      : `${whole}.${fraction.toString().padStart(2, "0").replace(/0$/, "")}`;
  return `${text}% of Shares`;
}
