#!/usr/bin/env node
// The events the relay's chain reader decodes, generated from the contracts/pot build.
//
//   node scripts/chain-reader-events.mjs           # rewrite the two generated files
//   node scripts/chain-reader-events.mjs --check   # fail when either is stale
//
// Needs `forge` on PATH (or FOUNDRY_BIN pointing at its folder) and a build in contracts/pot/out (`forge build` there).
//
// Four files are written, all under crates/buzz-relay/src/chain_reader:
//
//   testdata/pot-events.json  every event of the contracts the reader follows: name, canonical signature, the topic
//                             forge itself reports (`forge inspect <contract> events --json`), and each parameter's name,
//                             type and whether it is indexed (structs with their fields).
//   events_table.rs           the Rust table of those events (`EVENTS`), so no topic or field layout is ever typed by hand.
//   testdata/pot-abi.json     the one view whose answer is a struct, `TaskBook.taskOf`: its fields in the order the build gives.
//   views_table.rs            the Rust table of that tuple (`TASK_OF`), so the reader never counts words by hand. The Rust test
//                             `the_task_tuple_is_the_forge_abi` compares the table with pot-abi.json.
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
const ABI_FILE = resolve(READER, "testdata/pot-abi.json");
const VIEWS_FILE = resolve(READER, "views_table.rs");

// Contract (artifact name) and the roles whose logs it decodes. ShareToken is one code, two roles: backer Shares and
// Team Shares.
const CONTRACTS = [
  { contract: "Launcher", roles: ["Launcher"] },
  { contract: "Treasury", roles: ["Treasury"] },
  { contract: "Vester", roles: ["Vester"] },
  { contract: "Pair", roles: ["Pair"] },
  { contract: "ShareToken", roles: ["Shares", "Team"] },
  { contract: "PlayDollar", roles: ["Dollar"] },
  // A project's task queue (step 2); its address comes from the Treasury's TasksReady log.
  { contract: "TaskBook", roles: ["Tasks"] },
  // Step 4: a project's holder pause (its address comes from the Treasury's PauseReady log) and the deployment's earlier
  // backers' claim contract (its address comes from the Launcher's EarlierBound log).
  { contract: "HolderPause", roles: ["Pause"] },
  { contract: "EarlierGrants", roles: ["Earlier"] },
  // The Council round: when the deployment's Council switch is on the project's pause is a `HolderVote` (a `HolderPause`
  // that also holds the ballots), so one role has two event tables over the same address; and a project's Council, whose
  // address comes from the Launcher's `CouncilMade` log.
  { contract: "HolderVote", roles: ["Pause"] },
  { contract: "Council", roles: ["Council"] },
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

// ---- the one struct-valued view

/** `TaskBook.taskOf(serial)`: the fields of its (static) tuple, in order, from the build. */
function taskTuple() {
  const path = resolve(OUT_DIR, "TaskBook.sol", "TaskBook.json");
  const abi = JSON.parse(readFileSync(path, "utf8")).abi;
  const fn = abi.find((i) => i.type === "function" && i.name === "taskOf");
  if (!fn || fn.outputs.length !== 1 || fn.outputs[0].type !== "tuple") {
    throw new Error("TaskBook.taskOf no longer returns one struct: the reader's decoder must be rethought");
  }
  const fields = fn.outputs[0].components.map((c) => {
    if (c.type.startsWith("tuple") || c.type.includes("[") || c.type === "bytes" || c.type === "string") {
      throw new Error(`TaskBook.taskOf field ${c.name} is not static (${c.type}): the reader reads it by position`);
    }
    return { name: c.name, type: c.type };
  });
  return { view: "TaskBook.taskOf(uint64)", fields };
}

function viewsRust(tuple) {
  const rows = tuple.fields.map((f) => `    ("${f.name}", "${f.type}"),`).join("\n");
  return `// @generated by scripts/chain-reader-events.mjs from the contracts/pot build. Do not edit: change the contracts, run
// \`forge build\` in contracts/pot and run the script again. The Rust test \`the_task_tuple_is_the_forge_abi\` compares this
// table with testdata/pot-abi.json.

/// The fields of \`TaskBook.taskOf(serial)\`, in the order the contract returns them: name and Solidity type. One word each.
pub const TASK_OF: &[(&str, &str)] = &[
${rows}
];
`;
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
  const array = /^(.*)\[(\d+)\]$/.exec(t);
  if (array) return `Ty::Array(&${rustTy({ ...input, type: array[1] }, structs)}, ${array[2]})`;
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
  // One role can have two contracts: `HolderVote` is a `HolderPause`, so its ABI carries the pause's events too. The
  // table is by (role, event) and the second copy is left out; the recorded file keeps each contract's own ABI.
  const seen = new Set();
  for (const [contract, { roles, events: evs }] of Object.entries(list.contracts)) {
    for (const role of roles) {
      const fresh = evs.filter((e) => !seen.has(`${role}.${e.name}`));
      if (fresh.length === 0) continue;
      events.push(`    // ── ${role} (${contract})`);
      for (const e of fresh) {
        seen.add(`${role}.${e.name}`);
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
  const tuple = taskTuple();
  const abiText = `${JSON.stringify(tuple, null, 2)}\n`;
  const viewsText = formatted(viewsRust(tuple));
  if (check) {
    const stale = [
      [JSON_FILE, jsonText],
      [RUST_FILE, rustText],
      [ABI_FILE, abiText],
      [VIEWS_FILE, viewsText],
    ].filter(([file, text]) => !existsSync(file) || readFileSync(file, "utf8") !== text);
    if (stale.length > 0) {
      console.error(
        `${stale.map(([f]) => f).join(", ")} do not match the contracts/pot build: run node scripts/chain-reader-events.mjs`,
      );
      process.exit(1);
    }
    console.log("pot-events.json, events_table.rs, pot-abi.json and views_table.rs match the contracts/pot build");
    return;
  }
  writeFileSync(JSON_FILE, jsonText);
  writeFileSync(RUST_FILE, rustText);
  writeFileSync(ABI_FILE, abiText);
  writeFileSync(VIEWS_FILE, viewsText);
  console.log(`wrote ${JSON_FILE}, ${RUST_FILE}, ${ABI_FILE} and ${VIEWS_FILE}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
