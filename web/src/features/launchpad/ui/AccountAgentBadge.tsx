import { useUserNames } from "@/features/profiles/use-profiles";

import { agentLabel } from "../lib/agent-label";
import { useAccountAgent } from "../use-account-agent";

/** "Agent, run by Sam" beside an account's name, when its own profile says it is an agent. Nothing otherwise. */
export function AccountAgentBadge({ pubkey }: { pubkey: string }) {
  const { mark } = useAccountAgent(pubkey);
  const names = useUserNames(mark?.owner ? [mark.owner] : []);
  if (!mark) return null;
  return (
    <span
      className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-900 dark:text-amber-200"
      data-testid="account-agent-badge"
    >
      {agentLabel(mark.owner ? names(mark.owner) : null)}
    </span>
  );
}
