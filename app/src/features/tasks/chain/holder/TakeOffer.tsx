/**
 * The worker's press on a plan (plan section 5.8): where a plan is named for the signed-in person's wallet, "Set the money
 * aside" opens the Take sheet once it can be taken; before then the person reads when. Only the wallet the plan names is
 * offered it. A plan that names nobody says so and offers no press (the app never takes for a stranger). The runner, a
 * Pair's signer and anyone else read the plan and have no press.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import { isRunner, signsForRunner } from "../../../money/numbers";
import { WalletGate } from "../../../pot/use-pot";
import type { TaskSlotProps } from "../slot-props";
import { phaseOf } from "../state";
import { OPEN_TO_ANYONE, TAKE_OPEN, takeWait } from "./holder-words";
import { tiedWords } from "./plan-names";
import { TakeSheet } from "./TakeSheet";

const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

export function TakeOffer({
  chain,
  task,
  tasks,
  numbers,
  me,
  address,
  now,
}: TaskSlotProps) {
  const [open, setOpen] = useState(false);
  if (chain?.state !== "announced" || numbers.windDown) return null;
  const phase = phaseOf(chain, now);
  if (phase !== "notice" && phase !== "open") return null;
  if (chain.payee === null)
    return (
      <p className="text-sm" data-testid="take-open-to-anyone">
        {OPEN_TO_ANYONE}
      </p>
    );
  // The wallet the plan names, or the person whose own record named it (they may not have connected it yet).
  const named =
    same(address, chain.payee) ||
    (me !== null && task.worker === me && same(task.payTo, chain.payee));
  if (!named || isRunner(numbers, address) || signsForRunner(numbers, address))
    return null;
  if (phase === "notice")
    return (
      <p className="text-sm" data-testid="take-wait">
        {takeWait(chain.noticeEnd)}
      </p>
    );
  return (
    <WalletGate chainId={numbers.chainId} what="set the money aside">
      {(ready) => (
        <>
          <Button block data-testid="take-open" onClick={() => setOpen(true)}>
            {TAKE_OPEN}
          </Button>
          <TakeSheet
            numbers={numbers}
            onClose={() => setOpen(false)}
            open={open}
            queue={tasks}
            ready={ready}
            serial={chain.serial}
            what={tiedWords(chain, task)}
          />
        </>
      )}
    </WalletGate>
  );
}
