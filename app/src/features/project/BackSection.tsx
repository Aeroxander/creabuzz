/**
 * The Back box of a project's page, in one place: the box itself while the record is fresh, and when the record is too old to
 * trust (past a day) the sentence that backing waits while taking out does not. It is drawn once, in the top of the page.
 */
import { Card } from "../../ui/card";
import { type ProjectNumbers, freshnessOf } from "../money/numbers";
import { BackCard } from "../pot/BackCard";

export function BackSection({
  numbers,
  now,
  projectName,
}: {
  numbers: ProjectNumbers;
  now: number;
  projectName: string;
}) {
  if (freshnessOf(numbers, now).level === "stale")
    return (
      <Card data-testid="back-paused">
        <p className="text-sm">
          Backing waits until the numbers are fresh again. Taking your money out
          does not wait.
        </p>
      </Card>
    );
  return <BackCard now={now} numbers={numbers} projectName={projectName} />;
}
