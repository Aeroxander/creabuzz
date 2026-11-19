/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { deploymentsEnv } from "./src/lib/deployments-env";

// The network the build is for may come from the file the deploy script wrote (contracts/pot/deployments/pot-<chain>.json):
// `CREATON_DEPLOYMENTS_FILE=<path>` fills in VITE_CREATON_CHAIN_ID, _LAUNCHER and _DOLLAR where nothing else names them.
const deploymentsFile = process.env.CREATON_DEPLOYMENTS_FILE;
if (deploymentsFile)
  for (const [name, value] of Object.entries(
    deploymentsEnv(
      deploymentsFile,
      readFileSync(deploymentsFile, "utf8"),
      process.env,
    ),
  ))
    process.env[name] = value;

// The relay serves one web folder and only `/assets/*` from it as files (everything else gets the app shell), so every
// built file lands under `assets/`. `public/sw.js` is the one root file: a service worker controls only the path it is
// served from and below (see docs/next-version/PLANV2-M6-REPORT.md, open items).
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number.parseInt(process.env.VITE_PORT || "5174", 10),
    strictPort: true,
  },
  preview: { port: Number.parseInt(process.env.E2E_PORT || "4174", 10) },
  build: { target: "es2022", sourcemap: false },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    pool: "threads",
    maxWorkers: 2,
  },
});
