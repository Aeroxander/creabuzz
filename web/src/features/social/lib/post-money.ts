/**
 * The words on a post's money chip (N2): what was paid and what is still there, never added together. `amount` writes
 * a sum in the bounty's currency. Null when there is nothing to say.
 */
export function postMoneyLine(
  money: { paid: bigint; held: bigint },
  amount: (units: bigint) => string,
): { text: string; paidOnly: boolean } | null {
  if (money.paid > 0n && money.held > 0n) {
    return {
      text: `${amount(money.paid)} paid · ${amount(money.held)} available`,
      paidOnly: false,
    };
  }
  if (money.paid > 0n)
    return { text: `${amount(money.paid)} paid`, paidOnly: true };
  if (money.held > 0n)
    return { text: `${amount(money.held)} behind this`, paidOnly: false };
  return null;
}
