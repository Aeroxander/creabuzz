import { useState } from "react";
import { Button } from "../../ui/button";
import { Sheet } from "../../ui/sheet";
import { BRAIN_WORDS, setUpSteps } from "./brain-copy";

/** What a founder does to keep a brain: plain words first, the commands to run once under them, copyable. */
export function BrainSetup({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const steps = setUpSteps(projectId);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(steps);
      setSaid(BRAIN_WORDS.copied);
    } catch {
      setSaid(BRAIN_WORDS.copyFailed);
    }
  };
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) setSaid(null);
        onOpenChange(next);
      }}
      open={open}
      testId="brain-setup"
      title={BRAIN_WORDS.setUpTitle}
    >
      <p className="text-sm text-ink">{BRAIN_WORDS.setUpWhat}</p>
      <p className="text-sm text-muted">{BRAIN_WORDS.setUpWho}</p>
      <p className="text-sm text-ink">{BRAIN_WORDS.setUpWhere}</p>
      <pre
        className="whitespace-pre-wrap break-words rounded-xl bg-black/30 p-3 text-xs text-ink"
        data-testid="brain-steps"
      >
        {steps}
      </pre>
      <Button onClick={() => void copy()} variant="secondary">
        {BRAIN_WORDS.copy}
      </Button>
      {said ? (
        <p aria-live="polite" className="text-sm text-muted">
          {said}
        </p>
      ) : null}
      <p className="text-sm text-muted">{BRAIN_WORDS.setUpAfter}</p>
    </Sheet>
  );
}
