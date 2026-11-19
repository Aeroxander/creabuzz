import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import { Banknote } from "lucide-react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import {
  dayText,
  dollarsText,
  freshnessOf,
  type ProjectNumbers,
  type RemovedNumbers,
  timeText,
} from "./numbers";
import { OwnershipLine } from "./OwnershipLine";

/** The line every money screen carries on a test network: the dollars are play money. */
function PlayMoneyLine({ className }: { className?: string }) {
  return (
    <p className={className ?? "text-sm text-muted"} data-testid="play-money">
      This is a test network. The dollars are play money, not real money.
    </p>
  );
}

/**
 * The Money tab, step 1: the project's money from the server's record, with its age said plainly. A person's own
 * position and the Back and Take out sheets read the chain at the moment they open (RECORD-V2.md, section 5).
 */
export function MoneyNow({
  numbers,
  loading,
  error,
  onRetry,
  now,
}: {
  numbers: ProjectNumbers | RemovedNumbers | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
}) {
  if (loading) return <Card className="h-40 animate-pulse" />;
  if (error)
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} variant="secondary">
            Try again
          </Button>
        }
        title="The numbers could not be read"
      >
        {readFailureWords(error).text}
      </EmptyState>
    );
  if (!numbers || numbers.removed)
    return (
      <EmptyState
        icon={<Banknote size={28} />}
        testId="money-none"
        title={
          numbers?.removed ? "Not on the network any more" : "No numbers yet"
        }
      >
        <p>
          {numbers?.removed
            ? "This project's launch left the network, so it has no money to show."
            : "The server has not read this project's money yet. When it has, it shows here."}
        </p>
        <OwnershipLine className="mt-3 text-sm text-muted" />
      </EmptyState>
    );
  const age = freshnessOf(numbers, now);
  return (
    <div className="flex flex-col gap-3" data-testid="money-now">
      {mustSayPlayMoney(numbers.playMoney) ? <PlayMoneyLine /> : null}
      {age.level === "stale" ? (
        <Card data-testid="money-stale">
          <p>
            We have not been able to refresh this project's numbers since{" "}
            {dayText(numbers.builtAt)}. Your money is not affected: you can take
            it out any time.
          </p>
        </Card>
      ) : (
        <Card>
          <dl>
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-sm text-muted">The project's money</dt>
              <dd className="text-right font-semibold" data-testid="money-pot">
                {dollarsText(numbers.money.pot)}
              </dd>
            </div>
          </dl>
          {age.level === "as-of" ? (
            <p className="text-sm text-muted" data-testid="money-as-of">
              Numbers as of {timeText(numbers.asOf.time)}
            </p>
          ) : null}
          <p className="mt-2 text-sm text-muted">
            This can go up or down. It is not a return.
          </p>
        </Card>
      )}
      <OwnershipLine className="text-sm text-muted" />
    </div>
  );
}
