/**
 * One line under the acting account when its passkey account holds money (D141): what it holds, and where to send it
 * from (your profile's "Money in your passkey account"). Nothing when it holds none.
 */
import { Link } from "@tanstack/react-router";

import { existingUserPubkey } from "@/shared/lib/identity";

import { moneyText } from "../lib/send-money";
import { useAccountMoney } from "../use-account-money";

export function AccountMoneyNote({
  account,
  chainId,
  testIdPrefix,
}: {
  account: string;
  chainId: number | null;
  testIdPrefix: string;
}) {
  const me = existingUserPubkey();
  const money = useAccountMoney(account, chainId);
  const held = (money.data ?? []).filter((m) => m.balance > 0n);
  if (!me || held.length === 0) return null;
  return (
    <p className="mt-1" data-testid={`${testIdPrefix}-money`}>
      This account holds{" "}
      {held.map((m) => `${moneyText(m)} ${m.symbol}`).join(" and ")}.{" "}
      <Link className="underline" params={{ pubkey: me }} to="/u/$pubkey">
        Send it from your profile
      </Link>
    </p>
  );
}
