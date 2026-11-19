#!/usr/bin/env node
// The events the relay's chain reader decodes, generated from the contracts/pot build.
//
//   node scripts/chain-reader-events.mjs           # rewrite the two generated files
//   node scripts/chain-reader-events.mjs --check   # fail when either is stale
//
// Needs `forge` on PATH (or FOUNDRY_BIN pointing at its folder) and a build in contracts/pot/out (`forge build` there).
//
// Two files are written, both under crates/buzz-relay/src/chain_reader:
//
//   testdata/pot-events.json  every event of the six contracts the reader follows: name, canonical signature, the topic
//                             forge itself reports (`forge inspect <contract> events --json`), and each parameter's name,
//                             type and whether it is indexed (structs with their fields).
//   events_table.rs           the Rust table of those events (`EVENTS`), so no topic or field layout is ever typed by hand.
//
// The Rust test `the_table_is_the_forge_build` compares the table with pot-events.json field by field and recomputes every
// topic from the signature and compares it with forge's, so CI needs no contracts build; `--check` here compares both
// files with a fresh build. After an event changes in contracts/pot/src: build, run this, and handle the event in the
// reader (ledger.rs).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POT = resolve(repoRoot, "contracts/pot");
const OUT_DIR = resolve(POT, "out");
const READER = resolve(repoRoot, "crates/buzz-relay/src/chain_reader");
const JSON_FILE = resolve(READER, "testdata/pot-events.json");
const RUST_FILE = resolve(READER, "events_table.rs");

// Contract (artifact name) and the roles whose logs it decodes. ShareToken is one code, two roles: backer Shares and
// Team Shares.
const CONTRACTS = [
  { contract: "Launcher", roles: ["Launcher"] },
  { contract: "Treasury", roles: ["Treasury"] },
  { contract: "Vester", roles: ["Vester"] },
  { contract: "Pair", roles: ["Pair"] },
  { contract: "ShareToken", roles: ["Shares", "Team"] },
  { contract: "PlayDollar", roles: ["Dollar"] },
];
// Allowances are not read.
const SKIPPED = new Set(["ShareToken.Approval", "PlayDollar.Approval"]);

/** @param {{type: string, components?: object[]}} input */
function canonical(input) {
  if (input.type.startsWith("tuple")) {
    const inner = (input.components ?? []).map(canonical).join(",");
    return `(${inner})${input.type.slice("tuple".length)}`;
  }
  return input.type;
}

/** The ABI input as the JSON file keeps it. */
function shape(input) {
  const out = { name: input.name, type: canonical(input) };
  if (input.indexed !== undefined) out.indexed = input.indexed;
  if (input.type.startsWith("tuple")) {
    out.struct = (input.internalType ?? "").split(".").pop();
    out.components = input.components.map(shape);
  }
  return out;
}

function forgeTopics(contract) {
  const bin = process.env.FOUNDRY_BIN ? resolve(process.env.FOUNDRY_BIN, "forge") : "forge";
  const text = execFileSync(bin, ["inspect", contract, "events", "--json"], {
    cwd: POT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  /** @type {Record<string, string>} */
  const byName = {};
  for (const [signature, topic] of Object.entries(JSON.parse(text))) {
    byName[signature.split("(")[0]] = topic;
  }
  return byName;
}

function recorded() {
  const contracts = {};
  for (const { contract, roles } of CONTRACTS) {
    const path = resolve(OUT_DIR, `${contract}.sol`, `${contract}.json`);
    const abi = JSON.parse(readFileSync(path, "utf8")).abi;
    const topics = forgeTopics(contract);
    const events = abi
      .filter((item) => item.type === "event" && !SKIPPED.has(`${contract}.${item.name}`))
      .map((item) => {
        if (!topics[item.name]) throw new Error(`forge reports no topic for ${contract}.${item.name}`);
        return {
          name: item.name,
          signature: `${item.name}(${item.inputs.map(canonical).join(",")})`,
          topic: topics[item.name],
          inputs: item.inputs.map(shape),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    contracts[contract] = { roles, events };
  }
  return { source: "contracts/pot", contracts };
}

// ---- the Rust table

const SNAKE = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

function rustTy(input, structs) {
  const t = input.type;
  if (t.startsWith("(")) {
    const key = JSON.stringify(input.components);
    let found = structs.find((s) => s.key === key);
    if (!found) {
      let name = SNAKE(input.struct || input.name);
      while (structs.some((s) => s.name === name)) name += "_2";
      found = { key, name, components: input.components };
      structs.push(found);
    }
    return `Ty::Tuple(${found.name})`;
  }
  if (t === "address") return "Ty::Address";
  if (t === "bool") return "Ty::Bool";
  if (t === "bytes32") return "Ty::Bytes32";
  if (t === "bytes") return "Ty::Bytes";
  if (/^uint(8|16|24|32|64|128|160|256)$/.test(t)) return t === "uint256" ? "U256" : t === "uint64" ? "U64" : `Ty::Uint("${t}")`;
  if (/^int(8|16|24|32|64|128|256)$/.test(t)) return `Ty::Int("${t}")`;
  throw new Error(`the reader cannot decode a parameter of type ${t}`);
}

function rustParams(inputs, structs, indent) {
  return inputs
    .map((i) => {
      const fn = i.indexed ? "ix" : "p";
      return `${indent}${fn}("${i.name}", ${rustTy(i, structs)}),`;
    })
    .join("\n");
}

function rust(list) {
  const structs = [];
  const events = [];
  for (const [contract, { roles, events: evs }] of Object.entries(list.contracts)) {
    for (const role of roles) {
      events.push(`    // ── ${role} (${contract})`);
      for (const e of evs) {
        events.push(
          `    EventDef {\n        role: Role::${role},\n        name: "${e.name}",\n        params: &[\n${rustParams(e.inputs, structs, "            ")}\n        ],\n    },`,
        );
      }
    }
  }
  const consts = structs
    .map((s) => `const ${s.name}: &[Param] = &[\n${rustParams(s.components, structs, "    ")}\n];`)
    .join("\n");
  return `// @generated by scripts/chain-reader-events.mjs from the contracts/pot build. Do not edit: change the contracts, run
// \`forge build\` in contracts/pot and run the script again. The Rust test \`the_table_is_the_forge_build\` compares this
// table with testdata/pot-events.json, which holds the topics forge itself reports.

use super::{ix, p, EventDef, Param, Role, Ty, U256, U64};

${consts}

/// Every event the reader decodes, by the role of the contract that emits it. A log whose (role, topic) is not here is
/// not stored.
pub static EVENTS: &[EventDef] = &[
${events.join("\n")}
];
`;
}

/** The generated source, as rustfmt writes it (the repository's formatting gate would change it otherwise). */
function formatted(source) {
  return execFileSync("rustfmt", ["--edition", "2021", "--config", "max_width=100"], {
    input: source,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(OUT_DIR)) {
    console.error("contracts/pot/out is missing: run `forge build` in contracts/pot first");
    process.exit(1);
  }
  const list = recorded();
  const jsonText = `${JSON.stringify(list, null, 2)}\n`;
  const rustText = formatted(rust(list));
  if (check) {
    const stale = [
      [JSON_FILE, jsonText],
      [RUST_FILE, rustText],
    ].filter(([file, text]) => !existsSync(file) || readFileSync(file, "utf8") !== text);
    if (stale.length > 0) {
      console.error(
        `${stale.map(([f]) => f).join(", ")} do not match the contracts/pot build: run node scripts/chain-reader-events.mjs`,
      );
      process.exit(1);
    }
    console.log("pot-events.json and events_table.rs match the contracts/pot build");
    return;
  }
  writeFileSync(JSON_FILE, jsonText);
  writeFileSync(RUST_FILE, rustText);
  console.log(`wrote ${JSON_FILE} and ${RUST_FILE}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
