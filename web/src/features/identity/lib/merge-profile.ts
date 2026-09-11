/**
 * Merge a profile edit into the existing kind-0 metadata.
 *
 * Kind 0 is replaceable: the newest event *is* the profile, so publishing only
 * the fields one screen knows about deletes everything else. Editing a name in
 * the web client used to wipe the avatar, NIP-05 handle and payment address a
 * user had set anywhere else.
 *
 * Alias-free so `merge-profile.test.mjs` can drive it under `node --test`.
 */

export interface ProfilePatch {
  name?: string;
  about?: string;
  picture?: string | null;
}

/** Existing metadata, as stored (unknown keys are preserved verbatim). */
export type ProfileContent = Record<string, unknown>;

export function mergeProfileContent(
  current: ProfileContent | null | undefined,
  patch: ProfilePatch,
): ProfileContent {
  const content: ProfileContent = { ...(current ?? {}) };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length > 0) {
      content.name = name;
      content.display_name = name;
    } else {
      delete content.name;
      delete content.display_name;
    }
  }

  if (patch.about !== undefined) {
    const about = patch.about.trim();
    if (about.length > 0) content.about = about;
    else delete content.about;
  }

  // `picture` is tri-state: undefined leaves it alone (a name-only edit),
  // null removes it, a string sets it.
  if (patch.picture !== undefined) {
    if (typeof patch.picture === "string" && patch.picture.length > 0) {
      content.picture = patch.picture;
    } else {
      delete content.picture;
    }
  }

  return content;
}
