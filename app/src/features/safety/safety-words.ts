/** What the hiding and reporting of posts says, in one place. */

/** Said under the report's thanks: the post stops showing, here, until the person says otherwise. */
export const REPORTED_HIDDEN =
  "When you close this, the post is hidden for you on this phone.";

/** Where to undo a hide. */
export const hideWords = (done: string) =>
  `${done} You can show them again from You, then Account, then Hidden people.`;

/** Said in place of a post the reader reported. */
export const REPORTED_LINE = "You reported this post. It is hidden for you.";

/** Said in place of a post by someone the reader hid. */
export const HIDDEN_PERSON_LINE = "This is a post by someone you hid.";
