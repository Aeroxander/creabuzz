import assert from "node:assert/strict";
import test from "node:test";

import { CREATON_MINT, creatonVars } from "./creaton-palette.ts";

test("both modes define the same variables", () => {
  assert.deepEqual(
    Object.keys(creatonVars(true)).sort(),
    Object.keys(creatonVars(false)).sort(),
  );
});

test("every value is an HSL triple", () => {
  for (const isDark of [true, false]) {
    for (const [name, value] of Object.entries(creatonVars(isDark))) {
      assert.match(value, /^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/, name);
    }
  }
});

test("the action colour is mint and the page is a violet-black", () => {
  assert.equal(CREATON_MINT, "#35cc82");
  assert.equal(creatonVars(true)["--background"], "266 66% 8%");
});

test("a returned map is a copy, not the shared one", () => {
  const first = creatonVars(true);
  first["--background"] = "0 0% 0%";
  assert.equal(creatonVars(true)["--background"], "266 66% 8%");
});
