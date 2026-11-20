/**
 * A holder's Take out from a strip above the tabs: the same sheet as on the Money tab, opened where the plan is read. It is
 * loaded only when a holder's button is drawn (the sheet carries the money calls and their contract ABIs). Taking out reads
 * the chain alone: nothing about tasks stands in front of it.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import type { ProjectNumbers } from "../../../money/numbers";
import { targetOf } from "../../../pot/target";
import { TakeOutSheet } from "../../../pot/TakeOutSheet";
import { WalletGate } from "../../../pot/use-pot";
import { goToClaims } from "./claims-anchor";

export default function PlannedTakeOut({
  numbers,
  projectName,
  label,
  onOpenMoney,
}: {
  numbers: ProjectNumbers;
  projectName: string;
  label: string;
  onOpenMoney: () => void;
}) {
  const [open, setOpen] = useState(false);
  const queue =
    typeof numbers.tasks === "object" && numbers.tasks ? numbers.tasks : null;
  return (
    <WalletGate chainId={numbers.chainId} what="take out">
      {(ready) => (
        <>
          <Button
            data-testid="strip-take-out"
            onClick={() => setOpen(true)}
            size="sm"
            variant="secondary"
          >
            {label}
          </Button>
          <TakeOutSheet
            kind="backer"
            onClose={() => setOpen(false)}
            open={open}
            projectName={projectName}
            ready={ready}
            target={targetOf(numbers)}
            taskInfo={{
              dueSecs: queue?.limits.dueSecs ?? null,
              onWhereToClaim: () => {
                setOpen(false);
                goToClaims(onOpenMoney);
              },
            }}
          />
        </>
      )}
    </WalletGate>
  );
}
