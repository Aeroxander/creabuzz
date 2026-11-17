import { signInPasskeyIdentity } from "@creaton/core/account/passkey-identity.ts";
import { passkeyUnlockProblem } from "@creaton/core/account/passkey-problem.ts";
import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";

/**
 * A passkey account keeps its key in memory only, so after a reload it needs one tap before it can post or open
 * messages. Reading needs nothing.
 */
export function UnlockBar() {
  const { locked } = useAccount();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!locked) return null;
  return (
    <div
      className="glass mx-4 mt-3 flex flex-col gap-2 rounded-xl px-3 py-2 text-sm"
      data-testid="unlock-bar"
    >
      <div className="flex items-center justify-between gap-3">
        <span>Unlock with your passkey to post and read your messages.</span>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            signInPasskeyIdentity()
              .catch((error) => setProblem(passkeyUnlockProblem(error)))
              .finally(() => setBusy(false));
          }}
          size="sm"
          variant="secondary"
        >
          <Fingerprint aria-hidden="true" size={16} />
          Unlock
        </Button>
      </div>
      {problem ? (
        <p className="text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
