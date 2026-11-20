/**
 * What the founder says people who back the project get: their own words, with the fixed line under them that says these are
 * not money and not a promise of a return. The founder also has the press that edits them. A perk is text; nothing here
 * ever shows an amount.
 */
import { useState } from "react";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/field";
import { Sheet } from "../../ui/sheet";
import { useToast } from "../../ui/toast";
import { PERKS_MAX, type Project } from "../project/project-record";
import {
  PERKS_HEADING,
  PERKS_HINT,
  PERKS_LABEL,
  PERKS_NOT_MONEY,
} from "./room-words";
import { useSavePerks } from "./perks-record";

function PerksSheet({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState(project.perks ?? "");
  const [failed, setFailed] = useState(false);
  const save = useSavePerks(project);
  const toast = useToast();
  const tooLong = text.trim().length > PERKS_MAX;
  return (
    <Sheet
      description={PERKS_NOT_MONEY}
      onOpenChange={(next) => {
        if (next) setText(project.perks ?? "");
        setFailed(false);
        onOpenChange(next);
      }}
      open={open}
      testId="perks-sheet"
      title={PERKS_HEADING}
    >
      <TextArea
        count={{ used: text.trim().length, max: PERKS_MAX }}
        data-testid="perks-text"
        hint={PERKS_HINT}
        label={PERKS_LABEL}
        onChange={(e) => setText(e.target.value)}
        problem={tooLong ? "That is longer than the perks can be." : null}
        rows={5}
        value={text}
      />
      {failed ? (
        <p className="text-sm text-danger" role="alert">
          The perks were not saved. Try again.
        </p>
      ) : null}
      <Button
        data-testid="perks-save"
        disabled={tooLong || save.isPending}
        onClick={() => {
          setFailed(false);
          save.mutate(text, {
            onSuccess: () => {
              toast("Saved", "done");
              onOpenChange(false);
            },
            onError: () => setFailed(true),
          });
        }}
      >
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </Sheet>
  );
}

export function PerksBlock({
  project,
  isFounder,
}: {
  project: Project;
  isFounder: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (!project.perks && !isFounder) return null;
  return (
    <section
      aria-labelledby="room-perks-heading"
      className="flex flex-col gap-2"
      data-testid="room-perks"
    >
      <h3 className="text-base font-semibold" id="room-perks-heading">
        {PERKS_HEADING}
      </h3>
      {project.perks ? (
        <>
          <p className="whitespace-pre-wrap break-words text-base">
            {project.perks}
          </p>
          <p className="text-xs text-muted">{PERKS_NOT_MONEY}</p>
        </>
      ) : (
        <p className="text-sm text-muted">
          You have not said what people who back this get.
        </p>
      )}
      {isFounder ? (
        <>
          <div>
            <Button
              data-testid="perks-edit"
              onClick={() => setEditing(true)}
              size="sm"
              variant="secondary"
            >
              {project.perks ? "Edit the perks" : "Add perks"}
            </Button>
          </div>
          <PerksSheet
            onOpenChange={setEditing}
            open={editing}
            project={project}
          />
        </>
      ) : null}
    </section>
  );
}
