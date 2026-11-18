import { useId } from "react";

import { remixFit } from "@/features/launchpad/lib/remix";
import {
  SelectField,
  TextField,
} from "@/features/launchpad/ui/decision-fields";
import { useLaunches } from "@/features/launchpad/use-launches";

import type { ContributorDraft } from "../lib/contributor-project";

/**
 * Where the project comes from, and whether others may build on it (N11). Optional: picking nothing says it is a new
 * idea; leaving the box unticked says others are not invited (which they can still ask about).
 */
export function RemixFields({
  draft,
  onChange,
}: {
  draft: ContributorDraft;
  onChange: (patch: Partial<ContributorDraft>) => void;
}) {
  const id = useId();
  const launches = useLaunches();
  const all = launches.data ?? [];
  const chosen = all.find(
    (l) => `${l.record.author}:${l.record.id}` === draft.builtOn,
  );
  const fit = chosen
    ? remixFit(
        chosen.record.name,
        {
          ipRecord: chosen.record.ipRecord,
          remixTerms: chosen.record.remixTerms,
        },
        { ipRecord: null },
      )
    : null;
  return (
    <fieldset className="flex flex-col gap-3" data-testid="contributor-remix">
      <legend className="text-sm font-semibold">Where it comes from</legend>
      <SelectField
        hint="If this builds on another project here, name it: both pages will say so."
        label="Built on"
        onChange={(builtOn) => onChange({ builtOn })}
        options={[
          { value: "", label: "Nothing: a new idea" },
          ...all.map((l) => ({
            value: `${l.record.author}:${l.record.id}`,
            label: l.record.name,
          })),
        ]}
        testId="contributor-built-on"
        value={draft.builtOn ?? ""}
      />
      {fit ? (
        <p
          className={`text-xs ${fit.kind === "fits" ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300"}`}
          data-testid="contributor-built-on-fit"
        >
          {fit.line}
        </p>
      ) : null}
      <label
        className="flex items-start gap-2 text-sm"
        htmlFor={`${id}-invite`}
      >
        <input
          checked={draft.remixInvited === true}
          className="mt-1"
          data-testid="contributor-remix-invited"
          id={`${id}-invite`}
          onChange={(e) => onChange({ remixInvited: e.target.checked })}
          type="checkbox"
        />
        Others may build on this project
      </label>
      {draft.remixInvited ? (
        <TextField
          hint="Optional. In your own words; nothing here is enforced yet."
          label="What you ask in return"
          onChange={(remixAsks) => onChange({ remixAsks })}
          placeholder="Credit us on your page."
          testId="contributor-remix-asks"
          value={draft.remixAsks ?? ""}
        />
      ) : null}
    </fieldset>
  );
}
