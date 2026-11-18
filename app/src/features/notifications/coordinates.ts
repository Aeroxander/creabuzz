import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";

/** A project's founder and id from its record address (`37001:<founder>:<id>`), or null. */
function parseProjectCoordinate(
  coordinate: string,
): { author: string; id: string } | null {
  const match = new RegExp(`^${KIND_LAUNCH_RECORD}:([0-9a-f]{64}):(.+)$`).exec(
    coordinate,
  );
  return match ? { author: match[1], id: match[2] } : null;
}

/** The part of a project's link after `/p/`, from its record address; null when the address is not a project's. */
export function projectRefFromCoordinate(coordinate: string): string | null {
  const parsed = parseProjectCoordinate(coordinate);
  return parsed ? `${parsed.id}-${parsed.author.slice(0, 16)}` : null;
}
