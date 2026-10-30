/**
 * "Money in your passkey account" (D141), on your own profile: what the account holds, and a way to send it somewhere
 * else. A passkey account is held by no wallet app, so without this, money paid into it (a paid claim, a deposit or bond
 * coming back, what leaving a project pays) could only be spent on other actions here. Sending is one passkey prompt,
 * its fee covered like every other step, and is asked for twice: once with the amount and address, once with a sentence
 * saying exactly what goes where, because money sent to a wrong address is gone.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";

import { actingErrorMessage } from "../lib/acting-account";
import { moneyInput, moneyText, sendMoneyPlan } from "../lib/send-money";
import { useActingAccount } from "../use-acting-account";
import { ACCOUNT_MONEY_QUERY, useAccountMoney } from "../use-account-money";

export function AccountMoneyCard() {
  const account = useActingAccount();
  const address = account.kind === "passkey" ? account.address : null;
  const money = useAccountMoney(address, account.chainId);
  const queryClient = useQueryClient();
  const amountId = useId();
  const toId = useId();
  const [symbol, setSymbol] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [to, setTo] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  if (!address || account.chainId === null) return null;
  const held = (money.data ?? []).filter((m) => m.balance > 0n);
  const chosen = held.find((m) => m.symbol === symbol) ?? held[0] ?? null;
  const plan = chosen
    ? sendMoneyPlan({ held: chosen, amountText, to, from: address })
    : null;

  const send = async () => {
    if (!plan || "problem" in plan || account.chainId === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await account.sendCalls([plan.call], account.chainId);
      setSent(`${plan.summary}: sent.`);
      setReviewing(false);
      setAmountText("");
      setTo("");
    } catch (error) {
      setProblem(actingErrorMessage(error));
    } finally {
      await queryClient.invalidateQueries({
        queryKey: [...ACCOUNT_MONEY_QUERY],
      });
      setBusy(false);
    }
  };

  return (
    <Card className="mt-3 p-4" data-testid="account-money">
      <h2 className="text-sm font-semibold">Money in your passkey account</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Account <span className="font-mono">{truncatePubkey(address)}</span>.
        Payments for your work, deposits that come back and what you take when
        you leave a project arrive here.
      </p>
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="account-money-passkey"
      >
        Only this passkey can reach this account, its money and its Shares, so
        keep the passkey in a password manager that syncs it to your other
        devices.
      </p>
      {money.isError ? (
        <p className="mt-2 text-sm" role="status">
          The network did not answer, so the balance is not shown.{" "}
          <button
            className="underline"
            onClick={() => void money.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : money.data === undefined ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          Reading…
        </p>
      ) : (
        <ul className="mt-2 text-sm" data-testid="account-money-held">
          {money.data.map((m) => (
            <li key={m.symbol}>
              {moneyText(m)} {m.symbol}
            </li>
          ))}
        </ul>
      )}
      {sent ? (
        <p
          aria-live="polite"
          className="mt-2 text-sm"
          data-testid="account-money-sent"
          role="status"
        >
          {sent}
        </p>
      ) : null}
      {chosen && plan ? (
        <div className="mt-3 grid gap-2 text-sm">
          <h3 className="font-medium">Send money from this account</h3>
          {held.length > 1 ? (
            <fieldset className="flex flex-wrap gap-3">
              <legend className="sr-only">Which money</legend>
              {held.map((m) => (
                <label className="flex items-center gap-1" key={m.symbol}>
                  <input
                    checked={chosen.symbol === m.symbol}
                    disabled={busy}
                    name="account-money-kind"
                    onChange={() => {
                      setSymbol(m.symbol);
                      setReviewing(false);
                    }}
                    type="radio"
                  />
                  {m.symbol}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="font-medium" htmlFor={amountId}>
                Amount ({chosen.symbol})
              </label>
              <Input
                data-testid="account-money-amount"
                disabled={busy}
                id={amountId}
                inputMode="decimal"
                onChange={(e) => {
                  setAmountText(e.target.value);
                  setReviewing(false);
                }}
                value={amountText}
              />
            </div>
            <Button
              data-testid="account-money-all"
              disabled={busy}
              onClick={() => {
                setAmountText(moneyInput(chosen));
                setReviewing(false);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              All of it
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-medium" htmlFor={toId}>
              Send to (an address)
            </label>
            <Input
              data-testid="account-money-to"
              disabled={busy}
              id={toId}
              onChange={(e) => {
                setTo(e.target.value);
                setReviewing(false);
              }}
              placeholder="0x…"
              value={to}
            />
          </div>
          {reviewing && !("problem" in plan) ? (
            <div
              className="rounded-md border border-black/10 p-2 dark:border-white/10"
              data-testid="account-money-review"
            >
              <p>
                {plan.summary}. Sending cannot be undone: money sent to a wrong
                address is gone.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  aria-busy={busy}
                  data-testid="account-money-send"
                  disabled={busy}
                  onClick={() => void send()}
                  size="sm"
                  type="button"
                >
                  {busy ? "Confirm with your passkey…" : "Send it"}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => setReviewing(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Change something
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                data-testid="account-money-next"
                disabled={"problem" in plan}
                onClick={() => setReviewing(true)}
                size="sm"
                type="button"
              >
                Check and send
              </Button>
              {"problem" in plan && (amountText || to) ? (
                <p
                  className="mt-1 text-xs text-muted-foreground"
                  data-testid="account-money-problem"
                >
                  {plan.problem}
                </p>
              ) : null}
            </div>
          )}
          {problem ? (
            <p
              className="text-red-700 dark:text-red-300"
              data-testid="account-money-failed"
              role="alert"
            >
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
