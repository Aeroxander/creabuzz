import { useId, useState } from "react";
import {
  nameOf as profileName,
  type ProfileMetadata,
} from "../../lib/profiles";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import { useWalletAddress } from "../money/use-money";
import { SendSheet } from "./SendSheet";
import { asRunner, handOverData, windDownData } from "./team-calls";
import { type PairState, usePair } from "./use-team";
import { useTeamWallets } from "./use-wallets";

/**
 * Team on the Money tab, loaded only where the server turns investing on and the project has numbers: handing the
 * runner seat on, and winding down. The next step (a seat offered, the second seat, the Pair's waiting calls) sits above
 * the tabs, in `TeamTop`.
 */
export function TeamMoney({
  numbers,
  team,
  profiles,
}: {
  numbers: ProjectNumbers;
  /** Every teammate's account key (the founder first). */
  team: readonly string[];
  profiles: Record<string, ProfileMetadata> | undefined;
}) {
  const me = useWalletAddress().data ?? null;
  const pair = usePair(numbers).data ?? null;
  const wallets = useTeamWallets(team).data;
  const linked = team.flatMap((pubkey) => {
    const w = wallets?.[pubkey];
    return w?.state === "linked" ? [{ pubkey, address: w.address }] : [];
  });
  return (
    <div className="flex flex-col gap-3" data-testid="team-money">
      <RunnerCard
        candidates={linked.filter((c) => c.address !== me)}
        founderWallet={numbers.founder}
        me={me}
        nameOf={(pubkey) => profileName(profiles, pubkey)}
        numbers={numbers}
        pair={pair}
      />
    </div>
  );
}

function RunnerCard({
  numbers,
  me,
  pair,
  candidates,
  founderWallet,
  nameOf,
}: {
  numbers: ProjectNumbers;
  me: string | null;
  pair: PairState | null;
  candidates: { pubkey: string; address: string }[];
  founderWallet: string;
  nameOf: (pubkey: string) => string;
}) {
  const titleId = useId();
  const [sheet, setSheet] = useState<"hand-over" | "wind-down" | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const treasury = numbers.contracts.treasury;
  const market =
    numbers.stage.name === "council" || numbers.stage.name === "open";
  if (!treasury || numbers.clock.woundDown) return null;
  const via = (target: string, data: string) =>
    asRunner({ runner: numbers.runner, pair, me, target, data });
  const probe = via(treasury, handOverData(treasury, false));
  if (!probe) return null;
  const isFounder = me === founderWallet;
  const chosen = candidates.find((c) => c.pubkey === next) ?? null;
  const handOver = chosen
    ? via(
        treasury,
        handOverData(chosen.address, isFounder && leaving && !market),
      )
    : null;
  const windDown = market
    ? null
    : via(numbers.launcher, windDownData(numbers.key));
  const both = probe.through === "pair";
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="runner-card"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        The runner seat
      </h2>
      <div className="flex flex-wrap gap-2">
        {candidates.length > 0 ? (
          <Button
            data-testid="hand-over"
            onClick={() => setSheet("hand-over")}
            size="sm"
            variant="secondary"
          >
            Hand over
          </Button>
        ) : (
          <p className="text-sm text-muted">
            To hand over, a teammate first links their wallet on You.
          </p>
        )}
        {windDown ? (
          <Button
            data-testid="wind-down"
            onClick={() => setSheet("wind-down")}
            size="sm"
            variant="ghost"
          >
            Wind down
          </Button>
        ) : null}
      </div>
      <SendSheet
        action={`hand-over:${numbers.chainId}:${treasury}`}
        build={() => (handOver ? [handOver.call] : [])}
        chainId={numbers.chainId}
        confirmLabel={both ? "Ask your co-signer to confirm" : "Offer the seat"}
        copy="hand-over"
        disabled={!handOver}
        done={
          both
            ? "Asked. It happens when your co-signer confirms."
            : "Offered. They take the seat when they accept."
        }
        onOpenChange={(open) => setSheet(open ? "hand-over" : null)}
        open={sheet === "hand-over"}
        testId="hand-over-sheet"
        title="Hand over the runner seat?"
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-muted">
            Who runs the project next?
          </legend>
          {candidates.map((c) => (
            <label className="flex items-center gap-2" key={c.pubkey}>
              <input
                checked={next === c.pubkey}
                name="next-runner"
                onChange={() => setNext(c.pubkey)}
                type="radio"
              />
              {nameOf(c.pubkey)}
            </label>
          ))}
        </fieldset>
        {isFounder && !market ? (
          <label className="flex items-start gap-2">
            <input
              checked={leaving}
              onChange={(e) => setLeaving(e.target.checked)}
              type="checkbox"
            />
            <span>
              I am leaving the project. I keep the part of my Shares that
              matches the days I served out of 365; the rest goes back to the
              work pot.
            </span>
          </label>
        ) : null}
        <p className="text-muted">
          Nothing changes until they take the seat. Agents you set stop working
          then.
        </p>
      </SendSheet>
      {windDown ? (
        <SendSheet
          action={`wind-down:${numbers.chainId}:${treasury}`}
          build={() => [windDown.call]}
          chainId={numbers.chainId}
          confirmLabel={
            both ? "Ask your co-signer to confirm" : "Wind down for good"
          }
          copy="wind-down"
          done={
            both
              ? "Asked. It happens when your co-signer confirms."
              : "The project wound down."
          }
          onOpenChange={(open) => setSheet(open ? "wind-down" : null)}
          open={sheet === "wind-down"}
          testId="wind-down-sheet"
          title="Wind the project down, for good?"
        >
          {/* Before a market the runner may wind down alone (or both signers of a Pair). After a market only a Council
              may; whether a holders' wind-down needs a supermajority is the owner's question 19 (plan section 9). */}
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            <li>
              Payments to the project stop for good. This cannot be undone.
            </li>
            <li>
              Backers keep taking their unpaid money back, with only the
              platform's 1 of each 100 as the fee.
            </li>
            <li>
              The floor stays for holders to hand back against; the fee for that
              drops to the platform's 1 of each 100.
            </li>
            <li>Money the project can already spend stays the runner's.</li>
          </ul>
        </SendSheet>
      ) : null}
    </Card>
  );
}
