import * as React from "react";

import {
  parseSkillSource,
  SKILL_SCOPES,
  type SkillScope,
} from "@/features/agents/lib/skillLibrary";
import { olderRelayGuidance } from "@/features/agents/lib/relayNotice";
import type { PublishSkillInput } from "@/features/agents/lib/useSkillLibrary";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

type AddSkillDialogProps = {
  open: boolean;
  isPending: boolean;
  /** Validation/publish failure from the command — inline, never toast-only. */
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: PublishSkillInput) => void;
};

/**
 * Publish a SKILL.md as a kind:30180 skill: fetch from an https URL or paste
 * the file. Validation (frontmatter name/description, 64 KiB) runs in the
 * command against `buzz_persona::skill::parse_skill_md`, so the dialog shows
 * that error verbatim rather than pretending to be the validator.
 */
export function AddSkillDialog({
  open,
  isPending,
  error,
  onOpenChange,
  onSubmit,
}: AddSkillDialogProps) {
  const [url, setUrl] = React.useState("");
  const [pasted, setPasted] = React.useState("");
  const [appliesTo, setAppliesTo] = React.useState<SkillScope>("all");
  const [localError, setLocalError] = React.useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseSkillSource({ url, pasted });
    if (parsed.error !== null || parsed.source === null) {
      setLocalError(parsed.error ?? "Paste a SKILL.md or give its URL.");
      return;
    }
    setLocalError(null);
    onSubmit({
      ...(parsed.source.kind === "paste"
        ? { content: parsed.source.value }
        : { url: parsed.source.value }),
      appliesTo,
    });
  }

  const shownError = localError ?? error;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add skill</DialogTitle>
          <DialogDescription>
            Publish a SKILL.md to this project. Its name and description come
            from the file&apos;s frontmatter.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="skill-source-url">
              Skill URL
            </label>
            <Input
              id="skill-source-url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://ethskills.com/SKILL.md"
              type="url"
              value={url}
            />
            <p className="text-2xs text-muted-foreground">
              Catalog example: https://ethskills.com/SKILL.md
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="skill-source-paste">
              Or paste SKILL.md
            </label>
            <Textarea
              className="min-h-32 font-mono"
              id="skill-source-paste"
              onChange={(event) => setPasted(event.target.value)}
              placeholder={"---\nname: ethereum-dev\ndescription: …\n---"}
              value={pasted}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="skill-applies-to">
              Applies to
            </label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              id="skill-applies-to"
              onChange={(event) =>
                setAppliesTo(event.target.value as SkillScope)
              }
              value={appliesTo}
            >
              {SKILL_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {scope === "developers" ? "Developer work" : "All work"}
                </option>
              ))}
            </select>
          </div>
          {shownError ? (
            <div className="space-y-1.5">
              <p
                className="text-sm text-destructive"
                data-testid="skill-publish-error"
                role="alert"
              >
                {shownError}
              </p>
              {olderRelayGuidance(shownError) ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="skill-publish-guidance"
                >
                  {olderRelayGuidance(shownError)}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={isPending} type="submit">
              {isPending ? "Publishing…" : "Publish skill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
