/**
 * Running a project's helper (a persona) in this browser tab: how to recognize
 * a message meant for it, what it is told about itself, and how to read its
 * definition off the server. Alias-free; `persona-mention.test.mjs` drives it
 * under `node --test`.
 *
 * The tab agent used to be one fixed assistant ("@buzz-tab"). A project from a
 * template comes with named helpers (The Writer, The Producer) and the prompt
 * that makes each one itself; running one in the tab means answering to its
 * name and speaking with its prompt.
 */

/** A helper as the tab agent runs it. */
export interface TabPersona {
  /** The persona's id (`writer`), which is also its `d` on the server. */
  id: string;
  /** What people call it: "The Writer". */
  name: string;
  /** Who it is and how it works. */
  prompt: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A pattern for "@The Writer": the helper's full name after an @, ignoring
 * case and treating a space, dash or underscore between words as the same, so
 * `@the-writer` and `@The Writer` both reach it. The name must end where the
 * word ends: `@The Writers` is somebody else.
 */
export function personaMentionPattern(name: string): RegExp {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  if (words.length === 0) return /$^/;
  const body = words.map(escapeRegExp).join("[\\s_-]+");
  return new RegExp(`@${body}(?![\\p{L}\\p{N}])`, "iu");
}

/** What the helper is told before it answers a message in a channel. */
export function personaSystemPrompt(persona: TabPersona): string {
  return (
    `${persona.prompt.trim()}\n\n` +
    `You are ${persona.name}, an AI helper in a Creaton community channel. ` +
    "Answer the last message in character, concisely, using the channel context below."
  );
}

/** What the helper is told before it works a task. */
export function personaTaskPrompt(persona: TabPersona, extra: string): string {
  return (
    `${persona.prompt.trim()}\n\n` +
    `You are ${persona.name}, an AI helper in a Creaton community. ${extra}`
  );
}

/** The fields of a persona record this reads. */
export interface PersonaRecord {
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * The newest persona record for `id`, as a {@link TabPersona}, or null when
 * there is none or it cannot be read (no name, no prompt).
 */
export function pickPersona(
  id: string,
  records: readonly PersonaRecord[],
): TabPersona | null {
  const mine = records
    .filter((r) => r.tags.some((t) => t[0] === "d" && t[1] === id))
    .sort((a, b) => b.created_at - a.created_at);
  for (const record of mine) {
    try {
      const body: unknown = JSON.parse(record.content);
      if (!body || typeof body !== "object") continue;
      const { display_name: name, system_prompt: prompt } = body as Record<
        string,
        unknown
      >;
      if (
        typeof name === "string" &&
        name.trim() !== "" &&
        typeof prompt === "string" &&
        prompt.trim() !== ""
      ) {
        return { id, name: name.trim(), prompt };
      }
    } catch {
      // not JSON: try the next older record
    }
  }
  return null;
}
