/**
 * The project's money as a person first meets it: the money in the project, what one Share gives if taken out now, the
 * daily allowance in plain words, the Team's part and where the project stands. These are the server's record, said with
 * its age; the sheets that move money read the chain at the moment they open and never use these numbers.
 */
import { Row } from "../../ui/row";
import {
  dayText,
  freshnessOf,
  type ProjectNumbers,
  timeText,
} from "../money/numbers";
import {
  allowanceWords,
  NOT_A_RETURN,
  smallDollarsText,
  stateWords,
  teamPartPercent,
} from "../money/copy";

/** A record too old to show figures: what it means for the person's own money. */
export function StaleMoney({
  numbers,
  testId = "money-stale",
}: {
  numbers: ProjectNumbers;
  /** The page's top says it too, under its own name, so the Money tab's stays the only one of its name. */
  testId?: string;
}) {
  return (
    <div className="glass rounded-2xl p-4" data-testid={testId}>
      <p>
        We have not been able to refresh this project's numbers since{" "}
        {dayText(numbers.builtAt)}. Your money is not affected: you can take it
        out any time.
      </p>
    </div>
  );
}

export function MoneyFacts({
  numbers,
  now,
}: {
  numbers: ProjectNumbers;
  now: number;
}) {
  const age = freshnessOf(numbers, now);
  const state = stateWords(numbers, now);
  const team = teamPartPercent(numbers);
  return (
    <div
      className="glass flex flex-col gap-2 rounded-2xl p-4"
      data-testid="money-now"
    >
      <dl className="divide-y divide-white/10">
        <Row
          label="The project's money"
          strong
          testId="money-pot"
          value={smallDollarsText(numbers.money.pot)}
        />
        <Row
          label="What one Share gives if taken out now"
          strong
          testId="money-share-value"
          value={smallDollarsText(numbers.value.leaveValue)}
        />
        <Row
          label="Where it stands"
          strong
          testId="money-state"
          value={state.label}
        />
      </dl>
      {age.level === "as-of" ? (
        <p className="text-sm text-muted" data-testid="money-as-of">
          Numbers as of {timeText(numbers.asOf.time)}
        </p>
      ) : null}
      <p className="text-sm text-muted">{NOT_A_RETURN}</p>
      <p className="text-sm" data-testid="money-state-words">
        {state.meaning}
      </p>
      <p className="text-sm text-muted" data-testid="money-allowance">
        {allowanceWords(numbers)}
      </p>
      {team !== null ? (
        <p className="text-sm text-muted" data-testid="money-team-part">
          The team's side gets {team}% of anything above what backers put in.
          Backers are paid back what they put in first.
        </p>
      ) : null}
    </div>
  );
}
