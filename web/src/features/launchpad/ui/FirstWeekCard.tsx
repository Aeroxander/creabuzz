/**
 * The news slot at the top of a project page. A founder who has posted nothing gets "Your first week" in place of the
 * update card, so the page asks for one thing, not two; after the first update that card is one line above the update
 * card until the next update is due (`FirstWeekSteps`). Everyone else, and a founder whose updates could not be read to
 * their end, gets the update card.
 *
 * `useFirstWeekUpdates` is how the page knows: how many updates the project has, only when its updates were read to
 * their end, so a cut or failed read never tells a founder with updates that they have none.
 */

import { useMemo } from "react";

import { projectProgress } from "@/features/feed/lib/project-progress";
import { Button } from "@/shared/ui/button";

import { firstWeekForm, POST_UPDATE } from "../lib/first-week";
import type { Launch } from "../models";
import { useProjectUpdates } from "../use-help-requests";
import { FirstWeekSteps } from "./FirstWeekSteps";
import { ProjectUpdateCard } from "./ProjectUpdateCard";

/** How many updates the project has and when the newest was posted, or `null` for a read that did not reach its end. */
function useFirstWeekUpdates(launch: Launch): {
  updates: number | null;
  lastUpdateAt: number | null;
} {
  const data = useProjectUpdates(launch.record).data;
  return useMemo(() => {
    if (!data?.complete || data.postsCut)
      return { updates: null, lastUpdateAt: null };
    const items = projectProgress(
      [{ record: launch.record, updates: data.updates }],
      data.posts,
    ).filter((item) => !item.evidence);
    return {
      updates: items.length,
      lastUpdateAt:
        items.length > 0 ? Math.max(...items.map((i) => i.at)) : null,
    };
  }, [data, launch.record]);
}

export function ProjectNews({
  launch,
  isFounder,
  firstWeek,
  showCard,
  workTab,
  onPostUpdate,
  onAskForHelp,
  onOpenUpdates,
}: {
  launch: Launch;
  isFounder: boolean;
  /** The viewer may post as the founder (not an agent account), so the first-week card is theirs to see. */
  firstWeek: boolean;
  /** The update card is wanted here (it is not on the Updates tab, which lists the same things). */
  showCard: boolean;
  workTab: boolean;
  onPostUpdate: () => void;
  onAskForHelp: () => void;
  onOpenUpdates: () => void;
}) {
  const { updates, lastUpdateAt } = useFirstWeekUpdates(launch);
  const form = firstWeekForm({
    updates,
    lastUpdateAt,
    now: Math.floor(Date.now() / 1000),
  });
  const steps =
    firstWeek && form !== "gone" ? (
      <FirstWeekSteps
        form={form}
        lastUpdateAt={lastUpdateAt}
        launch={launch}
        onAskForHelp={onAskForHelp}
        onPostUpdate={onPostUpdate}
        updates={updates}
      />
    ) : null;
  // Before the first update the steps stand in for the update card. After it, the one line sits above the update card:
  // the update, the help it asks for and the offers on it are the founder's to read.
  if (form === "steps" && steps) return steps;
  const card = showCard ? (
    <ProjectUpdateCard
      isFounder={isFounder}
      launch={launch}
      onOpenUpdates={onOpenUpdates}
      onPostUpdate={onPostUpdate}
      workTab={workTab}
    />
  ) : null;
  if (!steps) return card;
  return (
    <>
      {steps}
      {card}
    </>
  );
}

/**
 * The founder's "Post this week's update" in the page header: an outline button, and not there at all while the
 * first-week card lists its three steps (the card has this very button as its third step). The green one is the next
 * step, and it sits in the card that asks for it: the first-week card, then the box that says the update is due. Right
 * after a post the page's green button is the reminder, so a second green button for the same action would compete.
 */
export function FounderPostButton({
  launch,
  firstWeek,
  onPost,
}: {
  launch: Launch;
  firstWeek: boolean;
  onPost: () => void;
}) {
  const { updates, lastUpdateAt } = useFirstWeekUpdates(launch);
  const stepsShowing =
    firstWeek &&
    firstWeekForm({
      updates,
      lastUpdateAt,
      now: Math.floor(Date.now() / 1000),
    }) === "steps";
  if (stepsShowing) return null;
  return (
    <Button data-testid="launch-post-update" onClick={onPost} variant="outline">
      {POST_UPDATE}
    </Button>
  );
}
