import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { deadlineFromDate, defaultDeadlineDate } from "../lib/bounty-copy";
import { parseUnits } from "../lib/dao-actions";
import {
  encodeFileClaim,
  encodeFundPostBounty,
  encodeOpenPostBounty,
  MAX_LENGTH,
  MAX_TEXT,
} from "../lib/open-bounty";
import { encodeApproveBounty } from "../lib/work-bounty";
import { UnauditedNotice } from "./UnauditedNotice";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

export interface BountyMoney {
  address: string;
  symbol: string;
  decimals: number;
}

const TEXTAREA =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** The amount typed in, as the currency's units, or a sentence saying what is wrong with it. */
function amountOf(
  text: string,
  currency: BountyMoney,
  balance: bigint | null,
  money: (units: bigint) => string,
): bigint | string {
  let amount: bigint;
  try {
    amount = parseUnits(text, currency.decimals, "amount", "The amount");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (amount === 0n) return "Put in more than zero.";
  if (balance !== null && amount > balance) {
    return `Your wallet holds ${money(balance)}, less than that.`;
  }
  return amount;
}

/** The two wallet steps every money form takes: allow the amount, then the step itself. */
async function allowThen(
  onSend: Send,
  contract: string,
  currency: BountyMoney,
  amount: bigint,
  key: string,
  data: string,
): Promise<boolean> {
  const allowed = await onSend(
    `${key}-allow`,
    currency.address,
    encodeApproveBounty(contract, amount),
  );
  return allowed ? onSend(key, contract, data) : false;
}

/** Focus the first field on mount: the button that opened the form is gone, so the keyboard lands here. */
function useFocusFirst<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className="text-xs text-red-700 dark:text-red-300" role="alert">
      {text}
    </p>
  ) : null;
}

function Actions({
  busy,
  gate,
  label,
  onGo,
  onCancel,
  testId,
}: {
  busy: string | null;
  gate: string | null;
  label: string;
  onGo: () => void;
  onCancel: () => void;
  testId: string;
}) {
  return (
    <>
      {gate ? <p className="text-xs text-muted-foreground">{gate}</p> : null}
      <div className="flex gap-2">
        <Button
          data-testid={testId}
          disabled={busy !== null || gate !== null}
          onClick={onGo}
          size="sm"
          type="button"
        >
          {busy !== null ? "Waiting for your wallet…" : label}
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          Cancel
        </Button>
      </div>
    </>
  );
}

/** Put money behind a post: the words for what done looks like, an amount and a deadline. */
const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function OpenPostBountyForm({
  post,
  contract,
  currency,
  balance,
  chainId,
  chainTime,
  gate,
  busy,
  onSend,
  onDone,
  onCancel,
  money,
}: {
  post: string;
  contract: string;
  currency: BountyMoney;
  balance: bigint | null;
  chainId: number;
  chainTime: number;
  gate: string | null;
  busy: string | null;
  onSend: Send;
  onDone: () => void;
  onCancel: () => void;
  money: (units: bigint) => string;
}) {
  const id = useId();
  const first = useFocusFirst<HTMLTextAreaElement>();
  const [words, setWords] = useState("");
  const [amountText, setAmountText] = useState("");
  const [dateText, setDateText] = useState(
    defaultDeadlineDate(chainTime, chainTime + MAX_LENGTH),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setProblem(null);
    const text = words.trim();
    if (byteLength(text) === 0) {
      setProblem("Say what done looks like.");
      return;
    }
    if (byteLength(text) > MAX_TEXT) {
      setProblem(`Keep it under ${MAX_TEXT} characters.`);
      return;
    }
    const amount = amountOf(amountText, currency, balance, money);
    if (typeof amount === "string") {
      setProblem(amount);
      return;
    }
    const deadline = deadlineFromDate(
      dateText,
      chainTime,
      chainTime + MAX_LENGTH,
    );
    if (deadline === null) {
      setProblem("Pick a date after today and within a year.");
      return;
    }
    const done = await allowThen(
      onSend,
      contract,
      currency,
      amount,
      "post-bounty-open",
      encodeOpenPostBounty(post, text, deadline, amount),
    );
    if (done) onDone();
  };
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="post-bounty-form">
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor={`${id}-words`}>
          What done looks like
        </label>
        <textarea
          className={TEXTAREA}
          data-testid="post-bounty-words-input"
          id={`${id}-words`}
          onChange={(e) => setWords(e.target.value)}
          placeholder="What has to be done, and how people can show it"
          ref={first}
          rows={3}
          value={words}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor={`${id}-amount`}>
          How much ({currency.symbol})
        </label>
        <Input
          data-testid="post-bounty-amount"
          id={`${id}-amount`}
          inputMode="decimal"
          onChange={(e) => setAmountText(e.target.value)}
          placeholder="25"
          value={amountText}
        />
        {balance !== null ? (
          <span className="text-xs text-muted-foreground">
            Your wallet holds {money(balance)}.
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor={`${id}-deadline`}>
          Work must be in by
        </label>
        <Input
          data-testid="post-bounty-deadline"
          id={`${id}-deadline`}
          onChange={(e) => setDateText(e.target.value)}
          type="date"
          value={dateText}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Anyone can add money and submit work. Each person who puts money in
        backs one piece of work; the work most of the money backs for nine days
        is paid. If none is, everyone gets their money back. Your wallet asks
        twice: once to allow the amount, once to put it in.
      </p>
      <UnauditedNotice chainId={chainId} />
      <Problem text={problem} />
      <Actions
        busy={busy}
        gate={gate}
        label="Put it in"
        onCancel={onCancel}
        onGo={() => void go()}
        testId="post-bounty-submit"
      />
    </div>
  );
}

/** Add money to a bounty that still takes it. */
export function AddMoneyForm({
  bountyId,
  contract,
  currency,
  balance,
  gate,
  busy,
  onSend,
  onDone,
  onCancel,
  money,
  deadline,
  refundsFrom,
}: {
  /** The bounty's deadline and the day refunds open whatever happens (Unix seconds), said beside the money. */
  deadline: number;
  refundsFrom: number;
  bountyId: bigint;
  contract: string;
  currency: BountyMoney;
  balance: bigint | null;
  gate: string | null;
  busy: string | null;
  onSend: Send;
  onDone: () => void;
  onCancel: () => void;
  money: (units: bigint) => string;
}) {
  const id = useId();
  const first = useFocusFirst<HTMLInputElement>();
  const [amountText, setAmountText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setProblem(null);
    const amount = amountOf(amountText, currency, balance, money);
    if (typeof amount === "string") {
      setProblem(amount);
      return;
    }
    const done = await allowThen(
      onSend,
      contract,
      currency,
      amount,
      `post-bounty-fund-${bountyId}`,
      encodeFundPostBounty(bountyId, amount),
    );
    if (done) onDone();
  };
  return (
    <div
      className="mt-2 flex flex-col gap-2"
      data-testid="post-bounty-add-form"
    >
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor={`${id}-amount`}>
          How much ({currency.symbol})
        </label>
        <Input
          data-testid="post-bounty-add-amount"
          id={`${id}-amount`}
          inputMode="decimal"
          onChange={(e) => setAmountText(e.target.value)}
          placeholder="25"
          ref={first}
          value={amountText}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        The work most of the money backs for nine days is paid. If none is, you
        can take yours back after {day(deadline)}, or from {day(refundsFrom)} if
        a piece of work is still running then. If you back a piece of work, this
        adds to your backing.
      </p>
      <Problem text={problem} />
      <Actions
        busy={busy}
        gate={gate}
        label="Put it in"
        onCancel={onCancel}
        onGo={() => void go()}
        testId="post-bounty-add-submit"
      />
    </div>
  );
}

/** Submit your work: where it is, as a link or a few words. */
export function SubmitWorkForm({
  bountyId,
  contract,
  gate,
  busy,
  onSend,
  onDone,
  onCancel,
}: {
  bountyId: bigint;
  contract: string;
  gate: string | null;
  busy: string | null;
  onSend: Send;
  onDone: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const first = useFocusFirst<HTMLTextAreaElement>();
  const [evidence, setEvidence] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setProblem(null);
    const text = evidence.trim();
    if (byteLength(text) === 0 || byteLength(text) > MAX_TEXT) {
      setProblem(`Say where your work is, in under ${MAX_TEXT} characters.`);
      return;
    }
    if (
      await onSend(
        `post-bounty-file-${bountyId}`,
        contract,
        encodeFileClaim(bountyId, text),
      )
    ) {
      onDone();
    }
  };
  return (
    <div
      className="mt-2 flex flex-col gap-2"
      data-testid="post-bounty-file-form"
    >
      <div className="flex flex-col gap-1 text-sm">
        <label className="font-medium" htmlFor={`${id}-evidence`}>
          Where your work is
        </label>
        <textarea
          className={TEXTAREA}
          data-testid="post-bounty-evidence"
          id={`${id}-evidence`}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="A link, or a few words"
          ref={first}
          rows={2}
          value={evidence}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        It cannot be changed once it is in. While your work is in, any money you
        put in does not count toward anyone's work.
      </p>
      <Problem text={problem} />
      <Actions
        busy={busy}
        gate={gate}
        label="Submit my work"
        onCancel={onCancel}
        onGo={() => void go()}
        testId="post-bounty-file-submit"
      />
    </div>
  );
}
