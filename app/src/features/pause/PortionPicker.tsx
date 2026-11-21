import { PORTION_WORDS, type Portion } from "../pot/takeout-read";

const PORTIONS: Portion[] = ["all", "half", "quarter"];

/** "All of it", "Half", "A quarter": the same three choices Take out has, as a labelled group of radio buttons. */
export function PortionPicker({
  legend,
  name,
  value,
  onChange,
  testIdPrefix,
}: {
  legend: string;
  name: string;
  value: Portion;
  onChange: (next: Portion) => void;
  testIdPrefix: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {PORTIONS.map((p) => (
          <label
            className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
            key={p}
          >
            <input
              checked={value === p}
              className="size-5 accent-current"
              data-testid={`${testIdPrefix}-${p}`}
              name={name}
              onChange={() => onChange(p)}
              type="radio"
              value={p}
            />
            {PORTION_WORDS[p]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
