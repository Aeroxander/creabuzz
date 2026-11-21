import { useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Sheet } from "../../ui/sheet";
import { BrainFileView } from "./BrainFileView";
import { BRAIN_WORDS, brainFailureWords } from "./brain-copy";
import type { BrainRepo } from "./brain-repo";
import { useBrainFiles } from "./use-brain";

/** The notes themselves, read once the sheet is open. */
function Files({ repo }: { repo: BrainRepo }) {
  const files = useBrainFiles(repo, true);
  // The first file is open to begin with; after a press, only the one pressed.
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  if (files.isPending)
    return (
      <Card className="h-24 animate-pulse" tone="plain">
        <span className="sr-only">{BRAIN_WORDS.loading}</span>
      </Card>
    );
  if (files.isError)
    return (
      <div
        className="flex flex-col gap-3"
        data-testid="brain-failure"
        role="alert"
      >
        <p className="text-sm text-ink">{brainFailureWords(files.error)}</p>
        <Button
          onClick={() => void files.refetch()}
          size="sm"
          variant="secondary"
        >
          {BRAIN_WORDS.tryAgain}
        </Button>
      </div>
    );
  if (files.data.length === 0)
    return <p className="text-sm text-muted">{BRAIN_WORDS.empty}</p>;
  const current = opened === undefined ? files.data[0]?.path : opened;
  return (
    <div className="flex flex-col gap-2">
      {files.data.map((file) => (
        <BrainFileView
          file={file}
          key={file.path}
          onToggle={() => setOpened(current === file.path ? null : file.path)}
          open={current === file.path}
        />
      ))}
      <p className="mt-1 text-xs text-muted">{BRAIN_WORDS.readOnly}</p>
    </div>
  );
}

/** The project's brain files in a sheet. Nothing is asked of the server until the sheet is open. */
export function BrainReader({
  repo,
  open,
  onOpenChange,
}: {
  repo: BrainRepo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet
      description={BRAIN_WORDS.readLead}
      onOpenChange={onOpenChange}
      open={open}
      testId="brain-reader"
      title={BRAIN_WORDS.readTitle}
    >
      {open ? <Files repo={repo} /> : null}
    </Sheet>
  );
}
