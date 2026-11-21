/** What saving a post says, in one place. */

/** The two choices in a post's More menu. */
export const SAVE = "Save this post";
export const UNSAVE = "Remove from saved";
export const SAVED_DONE = "Saved. Only you can see your saved posts.";
export const UNSAVED_DONE = "Removed from your saved posts.";

export const SAVED_TITLE = "Saved posts";
export const SAVED_PRIVATE = "Only you can see this list.";
export const SAVED_EMPTY_TITLE = "Nothing saved yet";
export const SAVED_EMPTY = "Press the bookmark under a post to keep it here.";
export const SAVED_READ_FAILED = "Your saved posts could not be opened";
export const SAVED_POSTS_FAILED = "Saved posts could not be read";
export const SAVED_SIGNED_OUT_TITLE = "Sign in to see your saved posts";

export const savedGone = (n: number) =>
  n === 1
    ? "1 saved post is no longer on this server. Its author may have removed it."
    : `${n} saved posts are no longer on this server. Their authors may have removed them.`;

export const savedHidden = (n: number) =>
  n === 1
    ? "1 saved post is not shown because you hid the person who wrote it or reported it."
    : `${n} saved posts are not shown because you hid the people who wrote them or reported them.`;

export const savedMore = (shown: number) =>
  `Showing your ${shown} newest saved posts.`;
