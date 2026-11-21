/**
 * "Confirm this account backs the project": the one press that links the person's wallet (or, on a phone, their passkey
 * account) to their account, so the server can see that they back the project. Back already does this as its last step, so
 * this is only for a Back made before that, or a step that was skipped, and for a link that is about to end.
 */
import { useId, useState } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { potProblem } from "../money/pot-copy";
import { useSenderWords } from "../money/use-money";
import { useLinkWallet } from "../team/use-wallets";
import { CONFIRM_LABEL, linkPublicFor } from "./room-words";

export function ConfirmAccount({ label = CONFIRM_LABEL }: { label?: string }) {
  const { pubkey } = useAccount();
  const link = useLinkWallet(pubkey);
  const words = useSenderWords();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();
  return (
    <div className="flex flex-col gap-2">
      {problem ? (
        <p className="text-sm text-danger" id={noteId} role="alert">
          {problem}
        </p>
      ) : null}
      <p className="text-sm text-muted" id={`${noteId}-public`}>
        {linkPublicFor(words.kind === "passkey")}
      </p>
      <Button
        aria-describedby={
          problem ? `${noteId} ${noteId}-public` : `${noteId}-public`
        }
        data-testid="room-confirm"
        disabled={link.isPending}
        onClick={() => {
          setProblem(null);
          link.mutate(undefined, {
            onSuccess: () => toast("Your account is confirmed.", "done"),
            onError: (error) => setProblem(potProblem(error, "link")),
          });
        }}
        size="sm"
        variant="secondary"
      >
        {link.isPending ? words.waiting : label}
      </Button>
    </div>
  );
}
