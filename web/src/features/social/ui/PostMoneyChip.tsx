import { Coins } from "lucide-react";

import { formatAtomic } from "@/features/launchpad/lib/amounts";
import { usePostMoney } from "@/features/launchpad/use-post-bounties";
import { Chip } from "@/shared/ui/chip";

import { postMoneyLine } from "../lib/post-money";

/**
 * Money behind a post (N2), as a chip on its card: what was paid and what its bounties still hold, apart. Nothing for a post
 * with no bounty, while the read is under way, or when this build names no bounty contract.
 */
export function PostMoneyChip({ post }: { post: string }) {
  const money = usePostMoney();
  const entry = money.data?.posts.get(`0x${post}`.toLowerCase());
  if (!money.data || !entry || !money.data.currency.decimalsKnown) return null;
  const { currency } = money.data;
  const line = postMoneyLine(entry, (units) =>
    `${formatAtomic(units, currency.decimals, { maxFractionDigits: 2 })} ${currency.symbol}`.trim(),
  );
  if (!line) return null;
  return (
    <Chip
      data-testid="social-post-money"
      icon={Coins}
      tone={line.paidOnly ? "neutral" : "success"}
    >
      {line.text}
    </Chip>
  );
}
