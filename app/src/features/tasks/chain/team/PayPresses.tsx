/**
 * The team's presses on a task that is taken on the network (plan sections 5.5 and 5.6): pay for the work, and send the money
 * back. Both are sheets that read the network when they open; the card shows the buttons while the task is taken and its
 * deadline has not passed. After the deadline the network ends the task by itself, so neither is offered.
 */
import { useState } from "react";
import { Button } from "../../../../ui/button";
import { nameOf } from "../../../../lib/profiles";
import { WalletGate } from "../../../pot/use-pot";
import { paidNotRecorded } from "../../paid-journal";
import type { TaskSlotProps } from "../slot-props";
import { canSendBack, isPastEnd } from "../state";
import type { ChainTask } from "../types";
import { AcceptSheet } from "./AcceptSheet";
import { PAY_OPEN, SEND_BACK_OPEN } from "./pay-words";
import { SendBackSheet } from "./SendBackSheet";
import { useSavePaid } from "./use-save-paid";
import { pressName } from "../../tasks-copy";

type Which = "accept" | "send-back" | null;

/** Whether the team's record is in a state a payment can be recorded against: work handed in, no payment on it yet. */
function payable(props: Pick<TaskSlotProps, "task">): boolean {
  const { task } = props;
  return (
    task.handIn !== null &&
    task.paidTx === null &&
    (task.state === "submitted" || task.state === "accepted")
  );
}

export function PayPresses(props: TaskSlotProps & { chain: ChainTask }) {
  const { chain, task, numbers, now, me } = props;
  const [which, setWhich] = useState<Which>(null);
  const save = useSavePaid({
    project: props.project,
    task,
    treasury: numbers.contracts.treasury,
    bookBlock: props.tasks.bookBlock,
    chain,
    fallbackNow: now,
  });
  const offerPay =
    me !== null &&
    payable(props) &&
    !isPastEnd(chain, now) &&
    paidNotRecorded(task.id) === null;
  const offerBack = canSendBack(chain, now) && chain.setAside > 0n;
  if (!offerPay && !offerBack) return null;
  const name =
    task.worker === me ? "You" : nameOf(props.profiles, task.worker ?? "");
  const links = {
    founder: props.project.author,
    agents: props.agents,
    operators: props.operators,
  };
  return (
    <WalletGate chainId={numbers.chainId} what="pay for this task">
      {(ready) => (
        <div className="flex flex-col gap-2" data-testid="pay-presses">
          {offerPay ? (
            <Button
              block
              data-testid="pay-open"
              aria-label={pressName(PAY_OPEN, task.what)}
              onClick={() => setWhich("accept")}
            >
              {PAY_OPEN}
            </Button>
          ) : null}
          {offerBack ? (
            <Button
              block
              data-testid="send-back-open"
              aria-label={pressName(SEND_BACK_OPEN, task.what)}
              onClick={() => setWhich("send-back")}
              variant="secondary"
            >
              {SEND_BACK_OPEN}
            </Button>
          ) : null}
          {offerPay && me !== null ? (
            <AcceptSheet
              chain={chain}
              links={links}
              me={me}
              numbers={numbers}
              project={props.project}
              onClose={() => setWhich(null)}
              onPaid={(piece) => void save.save(ready, piece)}
              onSendBack={() => setWhich("send-back")}
              open={which === "accept"}
              ready={ready}
              task={task}
              team={props.team}
              workerName={name}
            />
          ) : null}
          {offerBack ? (
            <SendBackSheet
              chain={chain}
              numbers={numbers}
              onClose={() => setWhich(null)}
              open={which === "send-back"}
              ready={ready}
              what={task.what}
            />
          ) : null}
        </div>
      )}
    </WalletGate>
  );
}
