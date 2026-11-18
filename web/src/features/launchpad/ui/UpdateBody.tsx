/**
 * The words of one team update. A weekly update is laid out under its promises and parts (`UpdateSections`), and the
 * help it asks for is a card people can answer; an update that cannot be laid out shows its words as written.
 */

import { type UpdateViewContext, updateView } from "../lib/update-view";
import type { Launch, LaunchUpdate } from "../models";
import { HelpRequestCard } from "./HelpRequestCard";
import { UpdateSections } from "./UpdateSections";

export function UpdateBody({
  launch,
  update,
  max,
  workTab,
  context,
}: {
  launch: Launch;
  update: LaunchUpdate;
  /** The most characters of the words to show before "Read more". */
  max: number;
  workTab: boolean;
  /** What is known of the founder's earlier updates, when the whole list was read (`ProjectUpdateCard`). */
  context?: Omit<UpdateViewContext, "founder">;
}) {
  const view = updateView(update, {
    ...context,
    founder: launch.record.author,
  });
  return (
    <>
      <UpdateSections max={max} view={view} />
      {update.help ? (
        <HelpRequestCard launch={launch} update={update} workTab={workTab} />
      ) : null}
    </>
  );
}
