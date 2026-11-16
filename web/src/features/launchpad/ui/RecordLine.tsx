import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  CheckCheck,
  CircleCheck,
  Flame,
  Hourglass,
  Users,
} from "lucide-react";

import { Chip } from "@/shared/ui/chip";

import {
  type RecordLineInput,
  recordLine,
  SEE_FULL_RECORD,
  scorecardSlug,
} from "../lib/record-line";

type RecordPart = ReturnType<typeof recordLine>["parts"][number];

const TONE: Record<RecordPart["tone"], "neutral" | "success" | "warning"> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
};

const ICON: Record<RecordPart["id"], typeof Flame> = {
  freshness: CalendarClock,
  started: CalendarClock,
  "first-update": CalendarClock,
  streak: Flame,
  kept: CircleCheck,
  accepted: Users,
  "done-alone": CheckCheck,
};

/**
 * A project's record in one line of chips (`lib/record-line.ts`), the same on the project page and the scorecard. Each
 * chip is words and an icon, never colour alone. A record that could not be read says so once, and a part it could
 * not read is left out. `project` makes the one link to the scorecard; leave it out where the line is the scorecard's.
 */
export function RecordLine({
  input,
  project,
}: {
  input: RecordLineInput;
  project?: { id: string; author: string };
}) {
  const { parts, cut } = recordLine(input);
  if (parts.length === 0 && !cut && !project) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="record-line">
      {parts.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {parts.map((part) => (
            <li data-testid={`record-line-${part.id}`} key={part.id}>
              <Chip
                icon={
                  part.id === "freshness" && part.tone === "warning"
                    ? Hourglass
                    : ICON[part.id]
                }
                tone={TONE[part.tone]}
              >
                {part.text}
              </Chip>
            </li>
          ))}
        </ul>
      ) : null}
      {cut ? (
        <p className="text-sm" data-testid="record-line-cut" role="status">
          {cut}
        </p>
      ) : null}
      {project ? (
        <Link
          className="inline-flex min-h-8 items-center text-sm text-primary-ink underline-offset-4 hover:underline max-sm:min-h-11"
          data-testid="record-line-link"
          params={{ slug: scorecardSlug(project) }}
          to="/p/$slug"
        >
          {SEE_FULL_RECORD}
        </Link>
      ) : null}
    </div>
  );
}
