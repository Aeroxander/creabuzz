import assert from "node:assert/strict";
import test from "node:test";

import { isEmbeddablePaperclipUrl } from "@/features/paperclip/lib/paperclipStatus";

test("iframe only embeds http(s) urls, never file/javascript/data", () => {
  assert.equal(isEmbeddablePaperclipUrl("http://127.0.0.1:3100"), true);
  assert.equal(isEmbeddablePaperclipUrl("https://paperclip.example.com"), true);
  assert.equal(isEmbeddablePaperclipUrl("file:///etc/passwd"), false);
  assert.equal(isEmbeddablePaperclipUrl("javascript:alert(1)"), false);
  assert.equal(isEmbeddablePaperclipUrl("data:text/html,<b>x</b>"), false);
  assert.equal(isEmbeddablePaperclipUrl("not a url"), false);
  assert.equal(isEmbeddablePaperclipUrl(""), false);
  assert.equal(isEmbeddablePaperclipUrl(null), false);
});
