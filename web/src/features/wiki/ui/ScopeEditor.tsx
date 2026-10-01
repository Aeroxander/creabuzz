import { useState } from "react";

/**
 * The admin scope editor: change a page's team scope or clear it, and settle a
 * conflicting-scope history by publishing one revision carrying the intended
 * scope. Saving republishes the page's content with the new (or dropped)
 * `t: team:<id>` tag — one atomic revision, which is also the relay's settle
 * path. Admins only; the caller role-gates.
 */
export function ScopeEditor({
  scope,
  conflicting,
  teams,
  busy,
  onCancel,
  onSave,
}: {
  /** The page's current scope (its head `t: team:<id>` value), or null. */
  scope: string | null;
  /** True when the history disagrees about the scope (admin settles it). */
  conflicting: boolean;
  /** Teams from the org chart for the picker. */
  teams: { id: string; name: string }[];
  busy: boolean;
  onCancel: () => void;
  onSave: (nextScope: string | null) => void;
}) {
  const [picked, setPicked] = useState<string>(scope ?? "");
  return (
    <section
      aria-label={conflicting ? "Settle scope" : "Change scope"}
      className="border-b border-black/10 bg-black/[0.03] px-3 py-2 dark:border-white/10 dark:bg-white/[0.04]"
      data-testid="wiki-scope-editor"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs font-medium text-black/70 dark:text-white/70">
          {conflicting ? "Settle scope" : "Page scope"}
        </span>
        <label className="sr-only" htmlFor="wiki-scope-select">
          Team this page is scoped to
        </label>
        <select
          className="rounded border border-black/15 bg-white px-2 py-1 text-2xs dark:border-white/15 dark:bg-white/10"
          data-testid="wiki-scope-select"
          id="wiki-scope-select"
          onChange={(e) => setPicked(e.target.value)}
          value={picked}
        >
          <option value="">No team — any member can edit</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
          {/* A scope the org chart cannot resolve stays selectable so it can
              be kept or cleared, not lost by accident. */}
          {scope && !teams.some((team) => team.id === scope) ? (
            <option value={scope}>{scope} (unknown team)</option>
          ) : null}
        </select>
        <button
          className="rounded-md bg-black px-2.5 py-1 text-2xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
          data-testid="wiki-scope-save"
          disabled={busy}
          onClick={() => onSave(picked === "" ? null : picked)}
          type="button"
        >
          Save scope
        </button>
        <button
          className="rounded border border-black/15 px-2 py-1 text-2xs dark:border-white/15"
          data-testid="wiki-scope-cancel"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
