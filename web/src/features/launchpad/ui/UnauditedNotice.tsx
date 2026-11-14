import { isMainnetChain, mainnetEnabled } from "../chain";

/**
 * Shown on every launch, bid and mint surface while real money is reachable:
 * the selected chain is a mainnet, or this build enabled mainnet presets.
 *
 * The launchpad contracts are unaudited and no legal posture exists yet
 * (docs/dao-os.md rule R4), so the notice is deliberately blunt and cannot be
 * dismissed. Test networks render nothing.
 */
export function UnauditedNotice({
  chainId,
}: {
  chainId?: number | string | null;
}) {
  if (!isMainnetChain(chainId) && !mainnetEnabled()) return null;
  return (
    <p
      className="mt-2 rounded-lg border border-red-500/40 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
      data-testid="unaudited-notice"
      role="note"
    >
      These contracts are unaudited. Do not use a network where the money is
      real; use a test network.
    </p>
  );
}
