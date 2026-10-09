/**
 * Reading values off a Nostr event: single tag values and the JSON object in
 * `content`. Pure and free of Vite-only aliases, so the modules the node test
 * runner imports directly can use it.
 */

/** The shape these helpers need: just the tags. */
export interface HasTags {
  tags: readonly (readonly string[])[];
}

/** The first tag named `name`'s value, or undefined when there is no such tag. */
export function getTag(event: HasTags, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/** The first non-empty value of a tag named `name` in `tags`, or null. */
export function tagValue(
  tags: readonly (readonly string[])[],
  name: string,
): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1].length > 0) {
      return tag[1];
    }
  }
  return null;
}

/** {@link tagValue} over an event's tags. */
export function eventTagValue(event: HasTags, name: string): string | null {
  return tagValue(event.tags, name);
}

/**
 * `content` parsed as a JSON object, or null when it is not valid JSON or not
 * an object (an array, a string, a number). Malformed content is a null parse,
 * never a crash.
 */
export function parseJsonObject(
  content: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/** {@link parseJsonObject} over an event's content. */
export function eventContentObject(event: {
  content: string;
}): Record<string, unknown> | null {
  return parseJsonObject(event.content);
}
