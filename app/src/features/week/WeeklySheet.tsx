import { useRef, useState } from "react";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { ManagerPanel } from "../manager/ManagerPanel";
import type { ProjectNumbers } from "../money/numbers";
import { potProblem } from "../money/pot-copy";
import { checkInFor } from "../money/runner";
import { useMoneySend } from "../money/use-money";
import type { Project } from "../project/project-record";
import { checkInAction, usePostWeekly, WEEKLY_MAX } from "./use-week";

/**
 * The weekly update: one box and one press. Where this wallet runs the project on the network, the same press also
 * checks in (the wallet confirms it). The record is signed and posted FIRST, and the check-in carries its hash (the
 * record's id), so the chain points at exactly what was said. A check-in that then fails says so, keeps the posted
 * update, and offers only the check-in again with the same hash. It never says a check-in happened when it did not.
 */
export function WeeklySheet({
  project,
  open,
  onOpenChange,
  checkIn,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the check-in goes: the Treasury for the runner, the Pair for one of its signers (`runner.ts` picks by `address`). */
  checkIn: { numbers: ProjectNumbers; address: string | null } | null;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  /** Set once the update is posted and its check-in did not go through: only the check-in is left to do. */
  const [posted, setPosted] = useState(false);
  /** The id of the record that was posted: the hash its check-in carries, kept for the retry. */
  const postedId = useRef<string | null>(null);
  const post = usePostWeekly();
  const send = useMoneySend(
    checkIn
      ? checkInAction(
          checkIn.numbers.chainId,
          checkIn.numbers.contracts.treasury,
        )
      : "",
  );
  /** Set while a submit runs: a second press before the button shows it is busy posts nothing twice. */
  const submitting = useRef(false);
  const toast = useToast();
  const busy = post.isPending || send.isPending;
  const empty = text.trim() === "";

  const close = () => {
    setText("");
    setProblem(null);
    setPosted(false);
    postedId.current = null;
    onOpenChange(false);
  };

  const sendCheckIn = async (recordHash: string) => {
    if (!checkIn) return true;
    const call = checkInFor(checkIn.numbers, checkIn.address, recordHash);
    if (!call) return true;
    try {
      await send.sendAsync({
        chainId: checkIn.numbers.chainId,
        build: () => [call],
      });
      return true;
    } catch (error) {
      setPosted(true);
      setProblem(
        `Your update is posted; the check-in did not go through. ${potProblem(error, "check-in")}`,
      );
      return false;
    }
  };

  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await submitOnce();
    } finally {
      submitting.current = false;
    }
  };

  const submitOnce = async () => {
    setProblem(null);
    if (!posted) {
      if (empty) {
        setProblem("Write a line about what you did.");
        return;
      }
      try {
        const signed = await post.mutateAsync({ project, text: text.trim() });
        postedId.current = signed.id;
      } catch (error) {
        setProblem(
          error instanceof Error
            ? error.message
            : "Your update was not posted. Try again.",
        );
        return;
      }
    }
    const hash = postedId.current;
    if (checkIn && !hash) return;
    if (await sendCheckIn(hash ?? "")) {
      toast(
        checkIn
          ? "Posted and checked in. The allowance keeps running."
          : "Posted",
        "done",
      );
      close();
    }
  };

  return (
    <Sheet
      description={
        checkIn
          ? "Updates are public. Your wallet confirms the check-in."
          : "Updates are public."
      }
      onOpenChange={(next) => {
        if (busy) return;
        if (next) onOpenChange(true);
        else close();
      }}
      open={open}
      testId="weekly-sheet"
      title={`This week on ${project.name}`}
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {posted ? null : (
          <TextArea
            count={{ used: text.length, max: WEEKLY_MAX }}
            data-testid="weekly-text"
            label="What did you do this week?"
            maxLength={WEEKLY_MAX}
            onChange={(event) => setText(event.target.value)}
            placeholder="For example: shipped the sign-up page and talked to five people who would use it."
            rows={4}
            value={text}
          />
        )}
        {posted ? null : (
          <ManagerPanel
            max={WEEKLY_MAX}
            onUse={(drafted) => setText(drafted)}
            project={project}
          />
        )}
        {problem ? (
          <p
            className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
            data-testid="weekly-problem"
            role="alert"
          >
            {problem}
          </p>
        ) : null}
        <Button block data-testid="weekly-post" disabled={busy} type="submit">
          {busy
            ? post.isPending
              ? "Posting…"
              : "Waiting for your wallet…"
            : posted
              ? "Check in again"
              : checkIn
                ? "Post and check in"
                : "Post"}
        </Button>
      </form>
    </Sheet>
  );
}
