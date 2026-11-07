import { useId } from "react";

import { Button } from "@/shared/ui/button";

import type { SecondaryMarketFacts } from "../lib/secondary-read";
import {
  encodeMintTestTokens,
  GET_TEST_TOKENS_LABEL,
  isTestQuote,
  MINT_TEST_TOKENS_WHOLE,
  TEST_TOKEN_NOTE,
} from "../lib/test-token";

/**
 * "Get test tokens" on the Trading card, only when the market's price token is the free test token this build names for
 * the project's network. It makes a fixed amount for the signed-in account through the card's own send path, and says
 * the token is free and worth nothing. Any other price token shows nothing here.
 */
export function TestTokenMint({
  quote,
  chainId,
  me,
  blocked,
  busy,
  gateNoteId,
  onSend,
}: {
  quote: SecondaryMarketFacts;
  chainId: string | null;
  /** The signed-in account's address; null with none. */
  me: string | null;
  blocked: boolean;
  busy: string | null;
  gateNoteId?: string;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const noteId = useId();
  if (!isTestQuote(quote.quoteToken, chainId)) return null;
  const describedBy = [noteId, gateNoteId].filter(Boolean).join(" ");
  return (
    <div className="mt-2 grid gap-1" data-testid="trading-test-tokens">
      <p className="text-sm" id={noteId}>
        {TEST_TOKEN_NOTE}
      </p>
      <div>
        <Button
          aria-describedby={describedBy}
          data-testid="trading-get-test-tokens"
          disabled={blocked || me === null}
          onClick={() => {
            if (me === null) return;
            void onSend(
              "trading-mint",
              quote.quoteToken,
              encodeMintTestTokens(me, quote.quoteDecimals),
            );
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy === "trading-mint"
            ? "Getting…"
            : `${GET_TEST_TOKENS_LABEL} (${MINT_TEST_TOKENS_WHOLE.toLocaleString("en-US")})`}
        </Button>
      </div>
    </div>
  );
}
