import type { ProjectNumbers } from "../money/numbers-v1";
import { useWalletAddress } from "../money/use-money";
import { PersonTeamActions } from "./PersonTeamActions";
import { usePair } from "./use-team-v1";
import { useTeamWallets } from "./use-wallets";

/**
 * Loaded only when a project has numbers and the server turns investing on: one teammate's Team actions on People. Every
 * row asks for the same reads, which are shared (one read of the team's wallets, one of the Pair).
 */
export function MemberActions({
  numbers,
  pubkey,
  team,
  name,
}: {
  numbers: ProjectNumbers;
  pubkey: string;
  /** Every teammate's key, so all rows share one read of their wallets. */
  team: readonly string[];
  name: string;
}) {
  const wallets = useTeamWallets(team).data;
  const me = useWalletAddress().data ?? null;
  const pair = usePair(numbers).data ?? null;
  return (
    <PersonTeamActions
      me={me}
      name={name}
      numbers={numbers}
      pair={pair}
      wallet={wallets?.[pubkey]}
    />
  );
}
