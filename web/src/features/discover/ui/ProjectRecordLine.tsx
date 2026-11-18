/**
 * What a Discover card says about a project's record, in plain words and with no score: the one line of its newest
 * weekly update as its author signed it, then how many weeks in a row it posted and how many answered promises it
 * kept. Nothing here is a price, an amount or a rank number, and nothing is made up: a project with no update has
 * nothing to say, and the card shows nothing.
 */

import { keptWords, type ProjectScore, streakWords } from "../lib/leaderboard";

export function ProjectRecordLine({
  score,
}: {
  score: ProjectScore | undefined;
}) {
  if (!score) return null;
  const facts = [streakWords(score.streak), keptWords(score)].filter(
    (fact): fact is string => fact !== null,
  );
  if (score.line === "" && facts.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="project-record-line">
      {score.line === "" ? null : (
        <p
          className="line-clamp-2 text-sm text-foreground/80"
          data-testid="project-record-summary"
        >
          {score.line}
        </p>
      )}
      {facts.length === 0 ? null : (
        <p
          className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-medium"
          data-testid="project-record-facts"
        >
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </p>
      )}
    </div>
  );
}
