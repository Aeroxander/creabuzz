/** What reposting, quoting, editing and deleting a post say. Plain words, one place. */

export const REPOST = "Repost";
export const UNREPOST = "Undo repost";
export const QUOTE = "Quote";
export const EDIT = "Edit";
export const DELETE = "Delete";

export const REPOSTED_DONE = "Reposted to the people who follow you";
export const UNREPOSTED_DONE = "Repost taken back";
export const POSTED_DONE = "Posted";
export const EDITED_DONE = "Post changed. The old one is taken down.";
export const DELETED_DONE = "Post deleted";

/** The line over a post someone reposted. */
export const repostedBy = (name: string) => `${name} reposted`;

/** Why a post with comments cannot be edited. */
export const EDIT_HAS_COMMENTS =
  "Editing sends a new post, so the comments on this one would be left behind.";

/** What an edit does, said in the writing box before it is sent. */
export const EDIT_EXPLAINED =
  "A post cannot be changed once it is sent. Saving sends your changed post and takes the old one down. Likes on the old one do not carry over.";

/** The question before a post is deleted, and what deleting can and cannot do. */
export const DELETE_TITLE = "Delete this post?";
export const DELETE_CAN =
  "Deleting takes your post off this server, so it stops showing here, in lists and in search.";
export const DELETE_CANNOT =
  "It cannot take back copies. Anyone who already saw or saved it, and any other server that took a copy, may still have it. Pictures in it may stay stored on this server.";

/** The words over the quoted post in the writing box. */
export const QUOTING = "Quoting";

/** Over a quoted post that cannot be shown. */
export const QUOTED_LOADING = "Loading the quoted post…";
export const QUOTED_REMOVED = "This post was removed.";
export const QUOTED_UNAVAILABLE = "This post isn't available right now.";
export const QUOTED_HIDDEN = "You hid this post.";
