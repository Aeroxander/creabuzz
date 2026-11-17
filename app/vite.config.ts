/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
