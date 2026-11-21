/**
 * Reading a project's brain files, read only. What the git library does is passed in (`GitTools`), so the rules below are
 * the ones the tests drive: which files are looked at, how big one may be, what counts as text, and how a long file is
 * cut. A file is only ever drawn as plain text (a text node, never markup), so a markdown or html file cannot run anything.
 */
import {
  BRAIN_PLAYBOOKS,
  BRAIN_TOP_FILES,
  type BrainRepo,
  PLAYBOOKS_MAX,
} from "./brain-repo";

/** The biggest file read at all: a brain file is notes, and a bigger one is not shown (it is said so, never half read). */
export const FILE_MAX_BYTES = 200_000;

/** How much of a file is shown at first, and how much each "Read on" press adds (characters). */
export const CHUNK_CHARS = 3_000;

/** A copy of the repository the reader looks into, closed (and forgotten) when the read is over. */
export interface GitCopy {
  /** The names in a folder (`""` is the top), or null when there is no such folder. */
  list(path: string): Promise<{ name: string; file: boolean }[] | null>;
  /** One file's bytes, or null when it is not there. A file over `maxBytes` comes back as `size` only, with no bytes. */
  read(
    path: string,
    maxBytes: number,
  ): Promise<{ size: number; bytes: Uint8Array | null } | null>;
  /** Forget the copy. */
  close(): Promise<void>;
}

/** What the app asks of the git library. */
export interface GitTools {
  /** The newest copy of the repository, as the signed-in person. */
  open(repo: BrainRepo): Promise<GitCopy>;
}

/** One file of the brain. */
export type BrainFile =
  | { path: string; kind: "text"; size: number; text: string }
  | { path: string; kind: "too-big"; size: number }
  | { path: string; kind: "not-text"; size: number };

/** Text with line ends made plain and every control character (the ones a screen would act on) taken out. */
export function plainText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(/[‪-‮⁦-⁩]/g, "")
  );
}

function decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readOne(copy: GitCopy, path: string): Promise<BrainFile | null> {
  const got = await copy.read(path, FILE_MAX_BYTES);
  if (!got) return null;
  if (got.size > FILE_MAX_BYTES || !got.bytes)
    return { path, kind: "too-big", size: got.size };
  if (got.bytes.subarray(0, 512).includes(0))
    return { path, kind: "not-text", size: got.size };
  const text = decode(got.bytes);
  if (text === null) return { path, kind: "not-text", size: got.size };
  return { path, kind: "text", size: got.size, text: plainText(text) };
}

const PLAYBOOK_FILE = /\.(md|markdown|txt)$/i;

/**
 * The brain's files: the four at the top that the scaffold writes, then the text files in `playbooks/` (at most
 * {@link PLAYBOOKS_MAX}, by name). A file that is not there is left out; none at all is an empty list. The copy is
 * closed whatever happens.
 */
export async function readBrain(
  tools: GitTools,
  repo: BrainRepo,
): Promise<BrainFile[]> {
  const copy = await tools.open(repo);
  try {
    const files: BrainFile[] = [];
    for (const path of BRAIN_TOP_FILES) {
      const file = await readOne(copy, path);
      if (file) files.push(file);
    }
    const entries = (await copy.list(BRAIN_PLAYBOOKS)) ?? [];
    const names = entries
      .filter((entry) => entry.file && PLAYBOOK_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, PLAYBOOKS_MAX);
    for (const name of names) {
      const file = await readOne(copy, `${BRAIN_PLAYBOOKS}/${name}`);
      if (file) files.push(file);
    }
    return files;
  } finally {
    await copy.close();
  }
}

/** How much of a text is shown after `pressed` "Read on" presses: a cut at a line end where there is one near. */
export function shownPart(
  text: string,
  pressed: number,
): { shown: string; more: boolean } {
  const upTo = CHUNK_CHARS * (pressed + 1);
  if (text.length <= upTo) return { shown: text, more: false };
  const cut = text.slice(0, upTo);
  const lineEnd = cut.lastIndexOf("\n");
  const at = lineEnd > upTo - 400 ? lineEnd : upTo;
  return { shown: text.slice(0, at), more: true };
}
