import { Button } from "@/shared/ui/button";
import { encodeClaimRound, type OpenClaim } from "../lib/weekly-rounds";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * Earlier rounds where you still have something to collect (D134): a new round never hides them. Each is one button;
 * the contract works out what is yours.
 */
export function RoundClaims({
  claims,
  contract,
  me,
  blocked,
  busy,
  onSend,
}: {
  claims: readonly OpenClaim[];
  contract: string;
  me: string | null;
  blocked: boolean;
  busy: string | null;
  onSend: Send;
}) {
  if (claims.length === 0 || !me) return null;
  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3"
      data-testid="rounds-claims"
    >
      <p className="text-sm font-medium">Waiting for you to collect</p>
      <ul className="flex flex-col gap-2">
        {claims.map((claim) => {
          const key = `rounds-claim-${claim.id}`;
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
              data-testid="rounds-claim"
              key={claim.id.toString()}
            >
              <span>
                Round {claim.id.toString()}:{" "}
                {claim.phase === "void"
                  ? "nobody settled it, so what you put in comes back."
                  : "settled, and your part is ready."}
              </span>
              <Button
                data-testid={key}
                disabled={blocked}
                onClick={() =>
                  void onSend(key, contract, encodeClaimRound(claim.id, me))
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {busy === key ? "Collecting…" : "Collect"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
