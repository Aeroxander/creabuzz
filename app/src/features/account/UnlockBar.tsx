import { useAccount } from "../../lib/account";
import { UnlockPress } from "./UnlockPress";

/**
 * A passkey account keeps its key in memory only, so after a reload it needs one tap before it can post or send
 * money. Reading needs nothing.
 */
export function UnlockBar() {
  const { locked } = useAccount();
  if (!locked) return null;
  return (
    <div
      className="glass mx-4 mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl px-3 py-2 text-sm"
      data-testid="unlock-bar"
    >
      <span>Unlock with your passkey to go on.</span>
      <UnlockPress />
    </div>
  );
}
