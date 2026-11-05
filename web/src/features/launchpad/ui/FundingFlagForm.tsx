/**
 * "Does the project's money include another token?" (D136), on the Funding card: sale prices count only the round's currency, and
 * a contract cannot list what it holds, so any holder who sees another token in the treasury can stop sales over it
 * until a vote decides. Lists the tokens already watched.
 */

import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { MoreInfo } from "@/shared/ui/more-info";
import { encodeFlagToken } from "@creaton/core/launchpad/fundingTerms.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function FundingFlagForm({
  dao,
  terms,
  watched,
  blocked,
  busy,
  onSend,
}: {
  dao: string;
  terms: string;
  watched: string[];
  blocked: boolean;
  busy: string | null;
  onSend: (key: string, to: string, data: string) => Promise<unknown>;
}) {
  const [token, setToken] = useState("");
  const inputId = useId();
  const valid = ADDRESS_RE.test(token.trim());
  return (
    <MoreInfo
      label="Does the project's money include another token?"
      testId="funding-flag"
    >
      <p>
        Sale prices count only USDC, so if the project holds another token,
        buyers would get part of it without paying for it. Any holder can stop
        sales while the project holds it; only a vote can let them go ahead.
      </p>
      <p className="mt-1" data-testid="funding-watched">
        {watched.length === 0
          ? "No other token is on the watch list yet; ETH always is."
          : `On the watch list besides ETH: ${watched.join(", ")}.`}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor={inputId}>
            Token address
          </label>
          <Input
            data-testid="funding-flag-input"
            id={inputId}
            onChange={(e) => setToken(e.target.value)}
            placeholder="0x…"
            value={token}
          />
        </div>
        <Button
          data-testid="funding-flag-submit"
          disabled={blocked || !valid}
          onClick={() =>
            void onSend("funding-flag", terms, encodeFlagToken(dao, token))
          }
          size="sm"
          type="button"
          variant="outline"
        >
          {busy === "funding-flag" ? "Stopping…" : "Stop sales over it"}
        </Button>
      </div>
    </MoreInfo>
  );
}
