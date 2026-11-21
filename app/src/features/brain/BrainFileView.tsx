import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { BRAIN_WORDS } from "./brain-copy";
import { type BrainFile, shownPart } from "./brain-read";

function sizeWords(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * One file of the brain: its name as one press that opens it, and its words drawn as plain text (a text node: never
 * markup, so nothing in a file can run or load anything). A long file shows its first part and a "Read on" press.
 */
export function BrainFileView({
  file,
  open,
  onToggle,
}: {
  file: BrainFile;
  open: boolean;
  onToggle: () => void;
}) {
  const panel = useId();
  const [pressed, setPressed] = useState(0);
  const part = file.kind === "text" ? shownPart(file.text, pressed) : null;
  return (
    <section
      className="flex flex-col gap-2"
      data-testid={`brain-file-${file.path}`}
    >
      <button
        aria-controls={panel}
        aria-expanded={open}
        className="flex min-h-11 w-full items-baseline justify-between gap-3 rounded-xl bg-white/5 px-3 py-2 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="font-semibold text-ink">{file.path}</span>
        <span className="num text-xs text-muted">{sizeWords(file.size)}</span>
      </button>
      <div hidden={!open} id={panel}>
        {file.kind === "too-big" ? (
          <p className="text-sm text-muted">{BRAIN_WORDS.tooBig}</p>
        ) : file.kind === "not-text" ? (
          <p className="text-sm text-muted">{BRAIN_WORDS.notText}</p>
        ) : part ? (
          <>
            <div
              className="whitespace-pre-wrap break-words px-1 text-sm text-ink"
              data-testid="brain-text"
            >
              {part.shown}
            </div>
            {part.more ? (
              <Button
                aria-label={`${BRAIN_WORDS.readOn}: ${file.path}`}
                className="mt-2"
                onClick={() => setPressed((n) => n + 1)}
                size="sm"
                variant="secondary"
              >
                {BRAIN_WORDS.readOn}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
