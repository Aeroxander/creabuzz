/** What Search says, in one place. */

export const SEARCH_TITLE = "Search";
export const SEARCH_LABEL = "Search";
export const SEARCH_PLACEHOLDER = "People, projects, posts or #topics";
export const SEARCH_HINT =
  "Find people by name, projects by name or line, and posts by their words. Start with # to open a topic.";
export const SEARCH_TOO_SHORT = "Type at least two letters.";

export const TOPICS_TITLE = "Topics people use";
export const TOPICS_NONE =
  "No topics yet. A post with a #topic in it starts one.";
export const TOPICS_FAILED = "Topics could not be read right now.";

export const PEOPLE_TITLE = "People";
export const PROJECTS_TITLE = "Projects";
export const POSTS_TITLE = "Posts";

export const topicLink = (tag: string) => `See the posts under #${tag}`;

export const NO_PEOPLE = "No one with those words in their name or line.";
export const NO_PROJECTS = "No project with those words in its name or line.";
export const NO_POSTS = "No post with those words in the newest posts.";
export const PEOPLE_FAILED = "People could not be searched. Try again.";
export const PROJECTS_FAILED = "Projects could not be read. Try again.";
export const POSTS_FAILED = "Posts could not be searched. Try again.";
export const POSTS_PARTLY =
  "Older posts could not be searched, so this list may be short.";
export const POSTS_HIDDEN = (n: number) =>
  n === 1
    ? "1 post is not shown because you hid the person who wrote it or reported it."
    : `${n} posts are not shown because you hid the people who wrote them or reported them.`;
export const SEARCHING = "Searching…";
export const TRY_AGAIN = "Try again";
