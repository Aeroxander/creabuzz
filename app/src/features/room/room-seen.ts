/**
 * What the person last saw of a room, for the "New" dot on its tab. Kept on this device only, every read and write inside
 * `try`, never held in a module-level variable: a device that cannot keep it reads as "never seen", so the dot shows and
 * news is never hidden.
 */
const KEY = "creaton.room.seen";

function readAll(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed))
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** The time (unix seconds) of the newest thing the person has seen in this project's room, or 0. */
export function roomSeenAt(coordinate: string): number {
  return readAll()[coordinate] ?? 0;
}

/** Note that the room was seen up to `at`. The newest wins; a device that cannot keep it drops it quietly. */
export function markRoomSeen(coordinate: string, at: number): void {
  try {
    const all = readAll();
    if ((all[coordinate] ?? 0) >= at) return;
    // The newest 200 rooms only: the list never grows without end.
    const kept = Object.entries({ ...all, [coordinate]: at })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage is off: the dot shows next time.
  }
}

/** Whether something in the room is newer than what the person last saw. */
export function hasNews(coordinate: string, newestAt: number): boolean {
  return newestAt > 0 && newestAt > roomSeenAt(coordinate);
}
