/**
 * A sale's treasury is the wallet that deploys it and receives the raise. A
 * quick setup never asks for one, so the deploy panel offers the connected
 * wallet in one click instead of sending the founder to paste an address.
 */

import { useState } from "react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

export function TreasuryFromWallet({
  address,
  onSetTreasury,
}: {
  address: string;
  onSetTreasury: (address: string) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const use = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSetTreasury(address);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-primary/10 px-3 py-2">
      <p className="text-sm">
        No treasury is set. It receives the raise and must be the wallet that
        deploys.
      </p>
      <Button
        data-testid="auction-use-wallet"
        disabled={saving}
        onClick={() => void use()}
        size="sm"
      >
        {saving ? "Saving…" : `Use ${truncatePubkey(address)} as the treasury`}
      </Button>
      {error ? (
        <p
          className="w-full text-xs text-red-600 dark:text-red-400"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
