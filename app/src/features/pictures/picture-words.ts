/** What the picture screens say. Plain words, one place. */

/** The name a picture without a description is read out with. */
export const NO_DESCRIPTION = "Picture (no description)";
/** Over a picture that cannot be shown because nobody is signed in on this phone. */
export const PICTURE_SIGN_IN = "Sign up to see pictures from this server";
/** Over a picture that cannot be shown while the passkey is locked. */
export const PICTURE_LOCKED = "Unlock to see this picture";
/** Over a picture the server would not hand over. */
export const PICTURE_UNAVAILABLE = "Picture can't be shown";
/** The press that shows a picture the reader hid. */
export const SHOW_PICTURE = "Picture hidden. Show it";
/** The More item that hides a post's pictures. */
export const hidePicturesWords = (count: number) =>
  count === 1 ? "Hide the picture" : "Hide the pictures";
/** The note after hiding. */
export const PICTURES_HIDDEN_DONE =
  "Hidden for you on this phone. Tap the covered picture to show it again. To tell the people who run this server about it, report the post.";

/** The hint under the box where a picture is described. */
export const ALT_HINT =
  "For people who use a screen reader. Say what the picture shows.";
/** Said in the writing box when a picture has no description yet. */
export const ALT_MISSING =
  "No description yet: people who use a screen reader will hear only that there is a picture.";
/** The words a failed upload starts with: nothing was posted and nothing typed is gone. */
export const UPLOAD_KEPT =
  "The picture did not upload, so nothing was posted. What you wrote and your pictures are still here.";
