/**
 * The room's small tasks, each in a sheet with a visible way out (Close in its corner, "Not now" below, and Escape): report a
 * post, the team's removal of a post, and the team's stop on a person writing. Each says in plain words what it does, what it
 * costs nobody, and what to do when it fails; none of them shows money.
 */
import { type ReactNode, useId, useState } from "react";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import type { SignedEvent } from "../posts/use-posts";
import {
  MUTE_DAYS,
  REMOVE_FAILED,
  REMOVE_REASON_MAX,
  REPORT_CHOICES,
  REPORT_DONE,
  type ReportChoice,
} from "./room-words";
import { useRemovePost, useReportPost, useStopWriting } from "./use-room";

/** One choice from a short list, as native radios in a labelled group. */
function Choices<T extends string | number>({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      {options.map((option) => (
        <label
          className="flex min-h-11 items-center gap-3 rounded-lg px-1"
          key={option.value}
        >
          <input
            checked={value === option.value}
            className="h-5 w-5 accent-mint"
            name={name}
            onChange={() => onChange(option.value)}
            type="radio"
            value={option.value}
          />
          <span className="text-base">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function ReportSheet({
  post,
  onOpenChange,
  onSent,
  afterSent,
}: {
  post: SignedEvent | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the post when the sheet closes after the report was sent (not when it is closed unsent). */
  onSent?: (post: SignedEvent) => void;
  /** Shown under the thanks once the report is sent (what else can be done about the person); it is given the way to close the sheet. */
  afterSent?: (close: () => void) => ReactNode;
}) {
  const report = useReportPost();
  const [choice, setChoice] = useState<ReportChoice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const close = (open: boolean) => {
    if (!open) {
      if (report.isSuccess && post) onSent?.(post);
      setChoice(null);
      setProblem(null);
      report.reset();
    }
    onOpenChange(open);
  };
  return (
    <Sheet
      description="The people who run this server will see it. Nothing is removed until they decide."
      onOpenChange={close}
      open={post !== null}
      testId="report-sheet"
      title="Report this post"
    >
      {report.isSuccess ? (
        <>
          <p className="text-sm" data-testid="report-done" role="status">
            {REPORT_DONE}
          </p>
          {afterSent?.(() => close(false))}
          <Button onClick={() => close(false)} variant="secondary">
            Done
          </Button>
        </>
      ) : (
        <>
          <Choices
            legend="What is wrong with it?"
            name="report-type"
            onChange={setChoice}
            options={REPORT_CHOICES}
            value={choice}
          />
          {problem ? (
            <p className="text-sm text-danger" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              data-testid="report-send"
              disabled={!choice || report.isPending}
              onClick={() => {
                if (!post || !choice) return;
                setProblem(null);
                report.mutate(
                  { post, type: choice },
                  {
                    onError: () =>
                      setProblem("The report was not sent. Try again."),
                  },
                );
              }}
            >
              {report.isPending ? "Sending…" : "Send report"}
            </Button>
            <Button onClick={() => close(false)} variant="ghost">
              Not now
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function RemoveSheet({
  post,
  onOpenChange,
}: {
  post: SignedEvent | null;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useRemovePost();
  const [reason, setReason] = useState("");
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const close = (open: boolean) => {
    if (!open) {
      setReason("");
      setFailed(false);
    }
    onOpenChange(open);
  };
  return (
    <Sheet
      description="The post leaves the room. The reason you give is kept in a public log."
      onOpenChange={close}
      open={post !== null}
      testId="remove-sheet"
      title="Remove this post"
    >
      <TextArea
        count={{ used: reason.length, max: REMOVE_REASON_MAX }}
        data-testid="remove-reason"
        label="Say why. The reason is kept in a public log."
        maxLength={REMOVE_REASON_MAX}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        value={reason}
      />
      {failed ? (
        <p className="text-sm text-danger" role="alert">
          {REMOVE_FAILED}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="remove-send"
          disabled={remove.isPending}
          onClick={() => {
            if (!post) return;
            setFailed(false);
            remove.mutate(
              { postId: post.id, reason },
              {
                onSuccess: () => {
                  toast("The post was removed.", "done");
                  close(false);
                },
                onError: () => setFailed(true),
              },
            );
          }}
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
        <Button onClick={() => close(false)} variant="ghost">
          Not now
        </Button>
      </div>
    </Sheet>
  );
}

export function MuteSheet({
  coordinate,
  person,
  name,
  onOpenChange,
}: {
  coordinate: string;
  /** The person to stop, or null while the sheet is shut. */
  person: string | null;
  name: string;
  onOpenChange: (open: boolean) => void;
}) {
  const stop = useStopWriting(coordinate);
  const [days, setDays] = useState<number>(7);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const note = useId();
  const close = (open: boolean) => {
    if (!open) setFailed(false);
    onOpenChange(open);
  };
  return (
    <Sheet
      description="They can still read. You can lift this any time."
      onOpenChange={close}
      open={person !== null}
      testId="mute-sheet"
      title={`Stop ${name} writing here`}
    >
      <Choices
        legend="For how long?"
        name="mute-days"
        onChange={setDays}
        options={MUTE_DAYS.map((d) => ({
          value: d,
          label: d === 1 ? "1 day" : `${d} days`,
        }))}
        value={days}
      />
      {failed ? (
        <p className="text-sm text-danger" id={note} role="alert">
          That was not saved. Try again.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          aria-describedby={failed ? note : undefined}
          data-testid="mute-send"
          disabled={stop.isPending}
          onClick={() => {
            if (!person) return;
            setFailed(false);
            stop.mutate(
              { person, days },
              {
                onSuccess: () => {
                  toast(`${name} cannot write here for now.`, "done");
                  close(false);
                },
                onError: () => setFailed(true),
              },
            );
          }}
        >
          {stop.isPending ? "Saving…" : "Stop writing"}
        </Button>
        <Button onClick={() => close(false)} variant="ghost">
          Not now
        </Button>
      </div>
    </Sheet>
  );
}
