import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { useWallet, useWalletAddress } from "../money/use-money";
import { teamProblem } from "./team-copy";
import { useLinkWallet, useTeamWallets } from "./use-wallets";

/**
 * Link this browser's wallet to the signed-in account, so teammates can offer a seat or give Shares to it. The wallet
 * signs a one-year proof that names this account; it moves nothing. Shown on You where the server turns investing on.
 */
export function LinkWallet({ me }: { me: string }) {
  const wallet = useWallet();
  const address = useWalletAddress().data ?? null;
  const linked = useTeamWallets([me]).data?.[me];
  const link = useLinkWallet(me);
  const toast = useToast();
  const titleId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  if (!wallet.isAvailable()) return null;
  const current = linked?.state === "linked" ? linked.address : null;
  const same = Boolean(current && address && current === address);
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-2"
      data-testid="link-wallet"
      role="region"
    >
      <h2 className="font-semibold" id={titleId}>
        Your wallet
      </h2>
      <p className="text-sm text-muted" data-testid="link-wallet-state">
        {current
          ? `Linked: the wallet ending ${current.slice(-4)}. Teammates can offer you a seat or give you Shares there.`
          : "Not linked yet. Link it so teammates can offer you a seat or give you Shares."}
      </p>
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      {same ? null : (
        <Button
          data-testid="link-wallet-press"
          disabled={link.isPending}
          onClick={() => {
            setProblem(null);
            link.mutate(undefined, {
              onSuccess: () => toast("Your wallet is linked.", "done"),
              onError: (error) => setProblem(teamProblem(error, "link")),
            });
          }}
          size="sm"
          variant="secondary"
        >
          {link.isPending
            ? "Waiting for your wallet…"
            : current
              ? "Link this wallet instead"
              : "Link this wallet"}
        </Button>
      )}
    </Card>
  );
}
