/**
 * Report a post, in a sheet with a visible way out (Close in its corner, "Not now" below, and Escape). It says in plain words
 * what it does and what to do when it fails; it shows no money.
 */
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { publishAsUser } from "../../lib/relay";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import type { SignedEvent } from "../posts/use-posts";
import { reportRecord } from "./room-records";
import { REPORT_CHOICES, REPORT_DONE, type ReportChoice } from "./room-words";

/** Tell the people who run the server about a post. */
function useReportPost() {
  return useMutation({
    mutationFn: (input: { post: SignedEvent; type: ReportChoice }) =>
      publishAsUser(
        reportRecord(input.post, input.type),
        "The report was not sent. Try again.",
      ),
  });
}

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
