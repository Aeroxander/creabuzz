import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BODY_MAX,
  cleanTitle,
  composePost,
  draftProblem,
  splitPost,
  TITLE_MAX,
} from "./post-text.ts";

describe("composePost / splitPost", () => {
  it("round-trips a title and a body", () => {
    const content = composePost(
      "Fund the trailer",
      "Two weeks, $4k.\n\n- music\n- edit",
    );
    assert.equal(
      content,
      "# Fund the trailer\n\nTwo weeks, $4k.\n\n- music\n- edit",
    );
    assert.deepEqual(splitPost(content), {
      title: "Fund the trailer",
      body: "Two weeks, $4k.\n\n- music\n- edit",
    });
  });

  it("writes only a heading when there is no body", () => {
    assert.equal(composePost("  Just a title  ", "   "), "# Just a title");
    assert.deepEqual(splitPost("# Just a title"), {
      title: "Just a title",
      body: "",
    });
  });

  it("keeps a title on one line", () => {
    assert.equal(cleanTitle("a\n\nb\t c"), "a b c");
    assert.equal(composePost("a\nb", "x"), "# a b\n\nx");
  });

  it("reads a post written without a heading by its first line", () => {
    assert.deepEqual(
      splitPost("Anyone tried the new editor?\nIt crashed twice."),
      {
        title: "Anyone tried the new editor?",
        body: "It crashed twice.",
      },
    );
    assert.deepEqual(splitPost("one line only"), {
      title: "one line only",
      body: "",
    });
  });

  it("does not hide text when a long first line is shortened", () => {
    const long = `${"word ".repeat(40)}end`;
    const { title, body } = splitPost(`${long}\nsecond`);
    assert.ok(title.endsWith("…"));
    assert.ok(title.length <= 100);
    assert.equal(body, `${long}\nsecond`);
  });

  it("strips Markdown marks from a title taken from a plain first line", () => {
    assert.equal(
      splitPost("**Bold** and [a link](https://x.y)").title,
      "Bold and a link",
    );
  });

  it("handles CRLF and empty content", () => {
    assert.deepEqual(splitPost("# T\r\n\r\nbody"), {
      title: "T",
      body: "body",
    });
    assert.deepEqual(splitPost("   "), { title: "", body: "" });
  });

  it("never returns an empty title for text that has content", () => {
    assert.equal(splitPost("****").title, "Untitled");
  });
});

describe("draftProblem", () => {
  it("asks for a title", () => {
    assert.equal(draftProblem("  ", "body"), "Give your post a title.");
  });
  it("limits the title and the body", () => {
    assert.match(
      draftProblem("x".repeat(TITLE_MAX + 1), "") ?? "",
      /under 140/,
    );
    assert.equal(draftProblem("x".repeat(TITLE_MAX), ""), null);
    assert.equal(
      draftProblem("ok", "x".repeat(BODY_MAX + 1)),
      "That post is too long.",
    );
    assert.equal(draftProblem("ok", "x".repeat(BODY_MAX)), null);
  });
});
