/**
 * The named helper's one press on a task made for them (plan section 5.8, C35): "This task is for you." and a button that
 * connects their wallet and writes their own `accept` step naming it, so the team can plan the pay to that wallet and the
 * network can be checked against it. The wallet is never typed: it is the account the wallet shares. Nothing is paid and
 * nothing moves; it is the helper saying yes and where.
 */
import { useState } from "react";
import { useRequireAccount } from "../../../../lib/use-require-account";
import { Button } from "../../../../ui/button";
import { useToast } from "../../../../ui/toast";
import { useConnectWallet, useWallet } from "../../../money/use-money";
import { senderKind } from "../../../money/wallet";
import { useTaskWrite } from "../../use-tasks";
import type { TaskSlotProps } from "../slot-props";
import {
  AGREE_DONE,
  AGREE_FAILED,
  agreeNoWallet,
  agreePress,
  agreeWords,
} from "./agree-words";
import { agreeRecord, offersAgree } from "./agree-record";
import { pressName } from "../../tasks-copy";

export function AgreeButton({ project, task, me }: TaskSlotProps) {
  const write = useTaskWrite(project);
  const connect = useConnectWallet();
  const passkey = senderKind(useWallet()) === "passkey";
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  if (!offersAgree(task, me)) return null;
  const agree = async () => {
    setProblem(null);
    let account: string;
    try {
      account = await connect.mutateAsync();
    } catch {
      return setProblem(agreeNoWallet(passkey));
    }
    write.mutate(
      {
        record: agreeRecord(project.coordinate, task, account),
        failure: AGREE_FAILED,
      },
      {
        onSuccess: () => toast(AGREE_DONE, "done"),
        onError: (error) => setProblem(error.message),
      },
    );
  };
  return (
    <div className="flex flex-col gap-2" data-testid="agree">
      <p className="text-sm" data-testid="agree-words">
        {agreeWords(passkey)}
      </p>
      {problem ? (
        <p className="text-sm text-danger" role="alert">
          {problem}
        </p>
      ) : null}
      <Button
        block
        data-testid="agree-press"
        aria-label={pressName(
          write.isPending ? "Saving…" : agreePress(passkey),
          task.what,
        )}
        disabled={write.isPending || connect.isPending}
        onClick={() => requireAccount(() => void agree())}
      >
        {write.isPending ? "Saving…" : agreePress(passkey)}
      </Button>
    </div>
  );
}
