// Prints the 4-byte method identifiers of a compiled contract artifact as one 0x-prefixed hex string, so
// SecondaryMarketAdversary.t.sol can compare the shipped ABI against its reviewed allowlist.
// usage: node market-abi.mjs <artifact.json> selectors
import { readFileSync } from "node:fs";

const [artifactPath, mode] = process.argv.slice(2);
if (!artifactPath || mode !== "selectors") {
  console.error("usage: market-abi.mjs <artifact.json> selectors");
  process.exit(1);
}
const ids = JSON.parse(readFileSync(artifactPath, "utf8")).methodIdentifiers;
if (!ids || typeof ids !== "object") {
  console.error("artifact has no methodIdentifiers");
  process.exit(1);
}
process.stdout.write(`0x${Object.values(ids).join("")}`);
