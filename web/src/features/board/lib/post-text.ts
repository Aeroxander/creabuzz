/**
 * A board post has a title and a body, but the server's post record has only
 * `content`. The title is the first line, written as a Markdown heading
 * (`# Title`), so the desktop app, which shows `content` as Markdown, shows
 * the same title the web does and no record needs a new field.
 *
 * A post made elsewhere without a heading still gets a title: its first line.
 *
 * Alias-free; `post-text.test.mjs` drives it under `node --test`.
 */

export const TITLE_MAX = 140;
/** The server refuses a post over 64 KiB; stay clear of it. */
export const BODY_MAX = 60_000;

/** A title is one line: runs of whitespace (newlines included) become one space. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** Why a draft cannot be posted, in plain words, or null when it can. */
export function draftProblem(title: string, body: string): string | null {
  const t = cleanTitle(title);
  if (t === "") return "Give your post a title.";
  if (t.length > TITLE_MAX) {
    return `Keep the title under ${TITLE_MAX} characters.`;
  }
  if (body.length > BODY_MAX) return "That post is too long.";
  return null;
}

/** The post's `content` for a title and a body. */
export function composePost(title: string, body: string): string {
  const heading = `# ${cleanTitle(title)}`;
  const text = body.trim();
  return text === "" ? heading : `${heading}\n\n${text}`;
}

/** Strip the Markdown a first line may carry, so a title reads as plain text. */
function plain(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Split a post's `content` into the title to show and the body under it. */
export function splitPost(content: string): { title: string; body: string } {
  const text = content.replace(/\r\n?/g, "\n").trim();
  if (text === "") return { title: "", body: "" };
  const newline = text.indexOf("\n");
  const first = newline === -1 ? text : text.slice(0, newline);
  const rest = newline === -1 ? "" : text.slice(newline + 1).trim();
  const heading = /^#{1,6}\s+(.+)$/.exec(first);
  if (heading) return { title: cleanTitle(heading[1]), body: rest };
  // No heading: the first line is the title. When it is cut short, the body
  // keeps the whole text, so nothing the author wrote is hidden.
  const line = plain(first) || "Untitled";
  const title = shorten(cleanTitle(line), 100);
  return { title, body: title === cleanTitle(line) ? rest : text };
}
