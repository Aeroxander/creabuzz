import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasFirstStep, markFirstStep } from "./first-steps.ts";

function memory(initial) {
  const data = new Map(initial ? [["creaton.first-steps", initial]] : []);
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    data,
  };
}

describe("first steps", () => {
  it("starts with nothing done", () => {
    assert.equal(hasFirstStep(memory(), "project"), false);
  });

  it("remembers a step once it is marked", () => {
    const storage = memory();
    markFirstStep(storage, "project");
    assert.equal(hasFirstStep(storage, "project"), true);
  });

  it("marking twice writes once", () => {
    const storage = memory();
    markFirstStep(storage, "project");
    const first = storage.data.get("creaton.first-steps");
    markFirstStep(storage, "project");
    assert.equal(storage.data.get("creaton.first-steps"), first);
  });

  it("treats a damaged record as nothing done, and repairs it on the next mark", () => {
    for (const bad of ["not json", "{}", '"project"', "[1,null]"]) {
      const storage = memory(bad);
      assert.equal(hasFirstStep(storage, "project"), false, bad);
      markFirstStep(storage, "project");
      assert.equal(hasFirstStep(storage, "project"), true, bad);
    }
  });

  it("never throws when storage refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(hasFirstStep(refusing, "project"), false);
    assert.doesNotThrow(() => markFirstStep(refusing, "project"));
  });
});
