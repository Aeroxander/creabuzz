/** The team's sentence about the pause: shown to the people who run the project only while a pause is armed or on. */
import type { TeamPause } from "./use-team-pause";
import { teamArmed, teamPaused } from "./pause-words";

export function TeamPauseLine({
  pause,
  id,
}: {
  pause: TeamPause | null;
  /** So a press can name this sentence as its description. */
  id?: string;
}) {
  if (!pause || pause.stage === "under") return null;
  return (
    <p className="text-sm" data-testid={`team-pause-${pause.stage}`} id={id}>
      {pause.stage === "paused"
        ? teamPaused(pause.divisor, pause.since)
        : pause.pausesFrom !== null
          ? teamArmed(pause.divisor, pause.pausesFrom)
          : null}
    </p>
  );
}
