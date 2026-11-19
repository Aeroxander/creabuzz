import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { useToast } from "../../ui/toast";
import type { ProjectNumbers } from "../money/numbers";
import { useMoneySend } from "../money/use-money";
import {
  AGENT_DOLLARS_MAX,
  AGENT_SHARES_MAX,
  DEFAULT_AGENT_DOLLARS,
  revokeAgentCall,
  setAgentCall,
} from "./task-calls";
import { limitsProblem } from "./tasks-copy";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHARE = 10n ** 18n;

/**
 * The runner sets what an agent's wallet may do for the project in a day (dollars sent and Shares given), or switches it
 * off. The limits live in the project's Treasury; the agent can never go past them, and a hand-over switches every agent
 * off. Only shown to the wallet that runs the project. The AI manager never gets a limit: it moves no money.
 */
export function AgentCaps({ numbers }: { numbers: ProjectNumbers }) {
  const titleId = useId();
  const [agent, setAgent] = useState("");
  const [dollars, setDollars] = useState(String(DEFAULT_AGENT_DOLLARS));
  const [shares, setShares] = useState("0");
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const treasury = numbers.contracts.treasury;
  const send = useMoneySend(`agent:${numbers.chainId}:${treasury ?? ""}`);
  const toast = useToast();
  if (!treasury) return null;
  const addressProblem = ADDRESS.test(agent.trim())
    ? null
    : "The agent's wallet address: 0x and 40 letters and digits.";
  const typedUsd = /^[0-9]{1,9}$/.test(dollars.trim())
    ? Number(dollars.trim())
    : null;
  const usd =
    typedUsd !== null && typedUsd <= AGENT_DOLLARS_MAX ? typedUsd : null;
  const typedShares = /^[0-9]{1,15}$/.test(shares.trim())
    ? BigInt(shares.trim())
    : null;
  const shareCount =
    typedShares !== null && typedShares <= AGENT_SHARES_MAX
      ? typedShares
      : null;
  const run = (build: () => ReturnType<typeof setAgentCall>, done: string) => {
    setTried(true);
    setProblem(null);
    if (addressProblem) return;
    send.send(
      { chainId: numbers.chainId, build: () => [build()] },
      {
        onSuccess: () => toast(done, "done"),
        onError: (error) => setProblem(limitsProblem(error)),
      },
    );
  };
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="agent-caps"
      role="region"
    >
      <div>
        <h2 className="headline text-xl" id={titleId}>
          Agent limits
        </h2>
        <p className="mt-1 text-sm text-muted">
          What a helper agent's wallet may send and give for the project in a
          day. It can never go past them. The AI manager never gets one.
        </p>
      </div>
      <Field
        data-testid="agent-address"
        label="Agent's wallet"
        onChange={(e) => setAgent(e.target.value)}
        placeholder="0x…"
        problem={tried ? addressProblem : null}
        value={agent}
      />
      <Field
        data-testid="agent-dollars"
        inputMode="numeric"
        label="Dollars a day"
        onChange={(e) => setDollars(e.target.value)}
        problem={
          tried && usd === null
            ? "Whole dollars from 0 to 1,000,000, like 25."
            : null
        }
        value={dollars}
      />
      <Field
        data-testid="agent-shares"
        inputMode="numeric"
        label="Shares a day"
        onChange={(e) => setShares(e.target.value)}
        problem={
          tried && shareCount === null
            ? "Whole Shares from 0 to 1,000,000,000,000, like 0."
            : null
        }
        value={shares}
      />
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="agent-set"
          disabled={send.isPending || usd === null || shareCount === null}
          onClick={() =>
            run(
              () =>
                setAgentCall(
                  treasury,
                  agent.trim(),
                  usd ?? 0,
                  (shareCount ?? 0n) * SHARE,
                ),
              "The agent's limits are set.",
            )
          }
        >
          Set limits
        </Button>
        <Button
          data-testid="agent-off"
          disabled={send.isPending}
          onClick={() =>
            run(
              () => revokeAgentCall(treasury, agent.trim()),
              "The agent is switched off.",
            )
          }
          variant="secondary"
        >
          Switch off
        </Button>
      </div>
    </Card>
  );
}
