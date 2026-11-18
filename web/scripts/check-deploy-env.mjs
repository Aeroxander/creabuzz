// Says what a hosted build will offer and refuses settings that do not fit together, before the app is built
// (the Dockerfile runs it; `src/features/launchpad/lib/deploy-env.ts` has the rules). Run it yourself with the same
// environment as the build: node --experimental-strip-types web/scripts/check-deploy-env.mjs
import { checkDeployEnv } from "../src/features/launchpad/lib/deploy-env.ts";

const { problems, warnings, summary } = checkDeployEnv(process.env);
console.log("This build of the web app:");
for (const line of summary) console.log(`  ${line}`);
if (warnings.length > 0) {
  console.warn("\nBefore inviting anyone:");
  for (const warning of warnings) console.warn(`  - ${warning}`);
}
if (problems.length > 0) {
  console.error("\nIt cannot be built for hosting as set:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
