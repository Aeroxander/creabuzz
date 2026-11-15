/**
 * The founder's update day for one project, kept in this browser (`lib/update-day.ts`). It starts as the weekday the
 * project was started and can be changed or turned off. Storage that cannot be read or written leaves the default and
 * the choice still holds for this visit.
 */

import { useCallback, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { progressScope } from "@/features/feed/use-progress-seen";

import {
  readUpdateDays,
  type StoredUpdateDays,
  updateDayOf,
  withUpdateDay,
  writeUpdateDay,
} from "../lib/update-day";
import { launchCoordinate, type Launch } from "../models";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useUpdateDay(project: Launch["record"]): {
  weekday: number;
  off: boolean;
  choose: (choice: number | "off") => void;
} {
  const scope = progressScope(
    relayWsUrl(),
    existingUserPubkey(),
    launchCoordinate(project.author, project.id),
  );
  const [stored, setStored] = useState<StoredUpdateDays>(() =>
    readUpdateDays(storage()),
  );
  const choose = useCallback(
    (choice: number | "off") => {
      writeUpdateDay(storage(), scope, choice);
      setStored((was) => withUpdateDay(was, scope, choice));
    },
    [scope],
  );
  return { ...updateDayOf(stored, scope, project.startedAt), choose };
}
