import { Coins } from "lucide-react";

import { formatAtomic } from "@/features/launchpad/lib/amounts";
import { usePostMoney } from "@/features/launchpad/use-post-bounties";
import { Chip } from "@/shared/ui/chip";

/**
 * Money behind a post (N2), as a chip on its card: what its bounties hold now, or what was paid. Nothing for a post
 * with no bounty, while the read is under way, or when this build names no bounty contract.
 */
export function PostMoneyChip({ post }: { post: string }) {
  const money = usePostMoney();
  const entry = money.data?.posts.get(`0x${post}`.toLowerCase());
  if (!money.data || !entry || !money.data.currency.decimalsKnown) return null;
  const { currency } = money.data;
  const amount =
    `${formatAtomic(entry.held, currency.decimals, { maxFractionDigits: 2 })} ${currency.symbol}`.trim();
  return (
    <Chip
      data-testid="social-post-money"
      icon={Coins}
      tone={entry.paid ? "neutral" : "success"}
    >
      {entry.paid ? `Paid ${amount}` : `${amount} behind this`}
    </Chip>
  );
}
