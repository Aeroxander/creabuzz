import { useEffect, useState } from "react";

import { type ClaimPick, rememberShown, resolvePick } from "../lib/claim-pick";

/**
 * A dispute form's chosen target. What the form first shows becomes the target (not just "the first option"), so if it
 * goes away on a refresh the form reports it gone and asks again, instead of quietly showing another and leaving an
 * amount typed against the old one. `requested` is a target the form was opened for.
 */
export function useStickyPick(
  keys: readonly string[],
  requested: string | null,
): { pick: ClaimPick; select: (key: string) => void } {
  const [selected, setSelected] = useState(() => requested ?? keys[0] ?? "");
  const pick = resolvePick(keys, requested, selected);
  useEffect(() => {
    const kept = rememberShown(selected, pick);
    if (kept !== selected) setSelected(kept);
  }, [selected, pick]);
  return { pick, select: setSelected };
}
