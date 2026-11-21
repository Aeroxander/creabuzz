/** What the topic page says, in one place. */

/** A topic is 2 to 32 letters, digits, `_` or `-`, as a post's own `#topic` is. */
export const TOPIC = /^[\p{L}\p{N}_-]{2,32}$/u;

/** The most posts one topic page reads. */
export const TOPIC_LIMIT = 100;

export const topicTitle = (tag: string) => `#${tag}`;
export const TOPIC_BAD_TITLE = "That is not a topic";
export const TOPIC_BAD =
  "A topic is two or more letters or digits after a #, like #lamps.";
export const topicEmptyTitle = (tag: string) => `No posts under #${tag} yet`;
export const TOPIC_EMPTY =
  "Write a post with this topic in it and it shows here.";
export const TOPIC_READ_FAILED = "This topic could not be read";
export const topicAllHidden = (n: number) =>
  n === 1
    ? "The only post under this topic is hidden for you: you hid the person who wrote it or reported it."
    : `All ${n} posts under this topic are hidden for you: you hid the people who wrote them or reported them.`;
export const topicSomeHidden = (n: number) =>
  n === 1
    ? "1 post is not shown because you hid the person who wrote it or reported it."
    : `${n} posts are not shown because you hid the people who wrote them or reported them.`;
export const topicOldest = (n: number) =>
  `Showing the newest ${n} posts under this topic.`;
