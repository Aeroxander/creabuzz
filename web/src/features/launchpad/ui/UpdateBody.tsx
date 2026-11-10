/**
 * The words of one team update. A weekly update shows its parts under the prompts they answered, and the help it asks
 * for as a card people can answer; a free-form update shows its words as written.
 */

import {
  bodyWithoutParts,
  PART_HEADINGS,
  type UpdateParts,
} from "../lib/weekly-update";
import type { Launch, LaunchUpdate } from "../models";
import { HelpRequestCard } from "./HelpRequestCard";

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function Part({
  heading,
  text,
  max,
}: {
  heading: string;
  text: string;
  max: number;
}) {
  if (!text) return null;
  return (
    <div className="mt-2" data-testid="update-part">
      <h4 className="text-xs font-semibold text-muted-foreground">{heading}</h4>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">
        {clip(text, max)}
      </p>
    </div>
  );
}

export function UpdateBody({
  launch,
  update,
  max,
  workTab,
}: {
  launch: Launch;
  update: LaunchUpdate;
  /** The most characters of any one part to show. */
  max: number;
  workTab: boolean;
}) {
  const parts: UpdateParts | null = update.parts ?? null;
  const free = bodyWithoutParts(update.body, parts);
  return (
    <>
      {free ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
          {clip(free, max)}
        </p>
      ) : null}
      {parts ? (
        <>
          <Part heading={PART_HEADINGS.done} max={max} text={parts.done} />
          <Part heading={PART_HEADINGS.next} max={max} text={parts.next} />
        </>
      ) : null}
      {update.help ? (
        <HelpRequestCard launch={launch} update={update} workTab={workTab} />
      ) : null}
    </>
  );
}
