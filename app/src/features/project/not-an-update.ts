/**
 * The records of kind 47003 that are about a project but are not something its team said: a season entry, leave or removal
 * (older servers still hold them) and a room stop. No Updates list shows them as an update.
 */
const NOT_AN_UPDATE = [
  "season-entry",
  "season-leave",
  "season-remove",
  "room-mute",
];

/** Whether a record of kind 47003 is one of those, never a project update. */
export function isNotAnUpdate(tags: readonly (readonly string[])[]): boolean {
  return tags.some((tag) => NOT_AN_UPDATE.includes(tag[0]));
}
