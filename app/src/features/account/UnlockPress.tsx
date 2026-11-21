import { signInPasskeyIdentity } from "@creaton/core/account/passkey-identity.ts";
import { passkeyUnlockProblem } from "@creaton/core/account/passkey-problem.ts";
import { Fingerprint } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/button";

/**
 * The one press that unlocks a passkey account after a reload, with what went wrong when it did not. It sits wherever a
 * locked account is told to unlock: the bar at the top, and inside a sheet that covers the bar (the recovery key, the
 * writing box), where the person must not have to close the sheet to find it.
 */
export function UnlockPress({ testId = "unlock" }: { testId?: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <Button
        data-testid={testId}
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
      {problem ? (
        <p className="basis-full text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}
