import test from "node:test";
import assert from "node:assert/strict";

import {
  eventContentObject,
  eventTagValue,
  getTag,
  parseJsonObject,
  tagValue,
} from "./event-fields.ts";

const event = {
  tags: [["d", "slug"], ["p", ""], ["p", "alice"], ["t"]],
};

test("getTag returns the first value, empty or not, and undefined when absent", () => {
  assert.equal(getTag(event, "d"), "slug");
  assert.equal(getTag(event, "p"), "");
  assert.equal(getTag(event, "t"), undefined);
  assert.equal(getTag(event, "missing"), undefined);
});

test("tagValue skips empty values and answers null when there is nothing to read", () => {
  assert.equal(tagValue(event.tags, "p"), "alice");
  assert.equal(tagValue(event.tags, "t"), null);
  assert.equal(tagValue(event.tags, "missing"), null);
  assert.equal(eventTagValue(event, "d"), "slug");
  assert.equal(eventTagValue({ tags: [] }, "d"), null);
});

test("content is read as an object, and anything else is a null parse", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.equal(parseJsonObject("[1,2]"), null);
  assert.equal(parseJsonObject('"text"'), null);
  assert.equal(parseJsonObject("null"), null);
  assert.equal(parseJsonObject("{not json"), null);
  assert.deepEqual(eventContentObject({ content: "{}" }), {});
});
