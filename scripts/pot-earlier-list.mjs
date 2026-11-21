#!/usr/bin/env node
// Makes the INVENTED list of the earlier-backers world of scripts/pot-full-loop.sh and prints it as JSON: the list's one
// fingerprint (a Merkle root), the pool, the number of rows, project zero's id and key, and one link per row (the address
// fragment a person is given: their row's place, amount and proof). The rows are the accounts and amounts given on the
// command line, made up for the run; nothing here reads or writes any real person's data, and the output goes only to the
// run's own temporary folder. The list's rules are the claim contract's (`contracts/pot/src/EarlierGrants.sol`), built by
// `packages/creaton-core/src/pot/earlier-proof.ts`; the app reads the links back, so a link that does not read is found by
// the run.
//
//   node --experimental-strip-types scripts/pot-earlier-list.mjs --founder 0x.. --nostr-pub <64 hex> --label zero \
//        --row 0x..:1000 --row 0x..:2500 ...        (an amount is a number of whole Team Shares)
import {
  chainKeyOf,
  projectIdOf,
} from "../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  buildEarlierTree,
} from "../packages/creaton-core/src/pot/earlier-proof.ts";

const args = process.argv.slice(2);
const take = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1)
    if (args[i] === name && args[i + 1] !== undefined) out.push(args[i + 1]);
  return out;
};
const one = (name) => {
  const [value] = take(name);
  if (!value) throw new Error(`${name} is needed`);
  return value;
};

const founder = one("--founder").toLowerCase();
const pub = one("--nostr-pub").toLowerCase();
const label = one("--label");
const rows = take("--row").map((text, index) => {
  const [account, whole] = text.split(":");
  if (!/^0x[0-9a-fA-F]{40}$/.test(account ?? "") || !/^\d+$/.test(whole ?? ""))
    throw new Error(`--row wants <address>:<whole Team Shares>, got ${text}`);
  return {
    index: BigInt(index),
    account: account.toLowerCase(),
    amount: BigInt(whole) * 10n ** 18n,
  };
});
if (rows.length === 0) throw new Error("at least one --row is needed");

const tree = buildEarlierTree(rows);
const projectId = projectIdOf(`37001:${pub}:${label}`);
const fragmentOf = (row, position) => {
  const json = JSON.stringify({
    index: row.index.toString(),
    amount: row.amount.toString(),
    proof: tree.proofOf(position),
  });
  return `#${Buffer.from(json, "utf8").toString("base64url")}`;
};

console.log(
  JSON.stringify({
    projectId,
    key: chainKeyOf(founder, projectId),
    root: tree.root,
    total: rows.reduce((sum, r) => sum + r.amount, 0n).toString(),
    rows: rows.length,
    links: rows.map((row, position) => ({
      index: Number(row.index),
      account: row.account,
      amount: row.amount.toString(),
      fragment: fragmentOf(row, position),
    })),
  }),
);
