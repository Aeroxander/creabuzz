import test from "node:test";
import assert from "node:assert/strict";

import {
  personaMentionPattern,
  personaSystemPrompt,
  personaTaskPrompt,
  pickPersona,
} from "./persona-mention.ts";

test("a helper answers to its full name, however the words are joined, and to nobody else", () => {
  const writer = personaMentionPattern("The Writer");
  for (const text of [
    "@The Writer what happens next?",
    "hey @the writer, a thought",
    "@the-writer",
    "@The_Writer!",
    "ok @THE WRITER.",
  ]) {
    assert.ok(writer.test(text), text);
  }
  for (const text of [
    "@The Writers",
    "@Writer",
    "The Writer without an at sign",
    "@The Producer",
    "email me at the.writer@example.com",
  ]) {
    assert.equal(writer.test(text), false, text);
  }
});

test("names with symbols and other scripts still make a safe pattern", () => {
  assert.ok(
    personaMentionPattern("The Sound & Music").test("@The Sound Music, please"),
  );
  assert.ok(
    personaMentionPattern("Scène Générateur").test("@scène générateur go"),
  );
  // A name with no letters matches nothing at all.
  assert.equal(personaMentionPattern("!!!").test("@anything"), false);
  // Characters that mean something in a pattern are plain text.
  assert.equal(personaMentionPattern("A.B").test("@AxB"), false);
});

test("the helper is told who it is, then how to answer", () => {
  const persona = {
    id: "writer",
    name: "The Writer",
    prompt: "  You write stories.  ",
  };
  const system = personaSystemPrompt(persona);
  assert.ok(system.startsWith("You write stories."));
  assert.match(
    system,
    /You are The Writer, an AI helper in a Creaton community channel/,
  );
  assert.match(
    personaTaskPrompt(persona, "This is a new task."),
    /You are The Writer, an AI helper in a Creaton community\. This is a new task\./,
  );
});

test("the newest readable record for the helper is the one used", () => {
  const record = (created_at, d, body) => ({
    created_at,
    tags: [["d", d]],
    content: typeof body === "string" ? body : JSON.stringify(body),
  });
  const records = [
    record(1, "writer", { display_name: "Old Writer", system_prompt: "old" }),
    record(5, "writer", {
      display_name: "The Writer",
      system_prompt: "You write.",
    }),
    record(9, "writer", "not json"),
    record(7, "writer", { display_name: "", system_prompt: "no name" }),
    record(9, "producer", {
      display_name: "The Producer",
      system_prompt: "You produce.",
    }),
  ];
  // Newer records that cannot be read are skipped, not trusted.
  assert.deepEqual(pickPersona("writer", records), {
    id: "writer",
    name: "The Writer",
    prompt: "You write.",
  });
  assert.equal(pickPersona("nobody", records), null);
  assert.equal(pickPersona("writer", []), null);
});
