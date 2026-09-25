#!/usr/bin/env node
/**
 * Static file server for desktop Playwright e2e runs.
 *
 * Replaces `python3 -m http.server 4173 -d dist` for e2e runs with a server
 * that closes the cross-test asset-staleness class:
 *
 *  - **`Cache-Control: no-store` on every response.** Python's
 *    SimpleHTTPRequestHandler only sends `Last-Modified`, which lets browsers
 *    apply heuristic freshness to `index.html` and keep executing a previous
 *    build's entry point (whose hashed chunk names no longer exist on disk).
 *  - **Serves exactly the directory named by `BUZZ_E2E_DIST`** — an immutable
 *    per-run build output created by `scripts/e2e-run.mjs` — so a concurrent
 *    `pnpm build`/`pnpm build:e2e` against the shared `dist/` can never
 *    change what a running suite executes.
 *  - **`GET /__e2e_server__`** reports `{ dir, port }` so a test that reaches
 *    the wrong server (e.g. the `web/` suite's `vite preview` on :4173) is
 *    diagnosable from the response body instead of a phantom failure.
 *
 * Usage (normally launched by Playwright's `webServer` in
 * `playwright.config.ts`):
 *
 *     BUZZ_E2E_PORT=4311 BUZZ_E2E_DIST=/abs/.e2e-dist/<runId> \
 *       node scripts/e2e-static-server.mjs
 *
 * Falls back to port 4173 / `dist` for bare `playwright test` runs.
 */
import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const port = Number(process.env.BUZZ_E2E_PORT ?? 4173);
const root = path.resolve(process.env.BUZZ_E2E_DIST ?? "dist");

/** Distinct missing paths are logged once so 404 storms stay bounded.
 * Logs go to stderr: Playwright only forwards the webServer's stderr into
 * the test output (`stdout: "ignore"` default). */
const missingLogged = new Set();

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    res.writeHead(500, { "Cache-Control": "no-store" });
    res.end(`e2e static server error: ${err?.message ?? err}`);
  });
});

async function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Cache-Control": "no-store", Allow: "GET, HEAD" });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/__e2e_server__") {
    const body = JSON.stringify({ ok: true, dir: root, port });
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  // Resolve inside the run dir; reject traversal.
  const filePath = path.join(root, path.normalize(pathname));
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(403, { "Cache-Control": "no-store" });
    res.end("forbidden");
    return;
  }

  let stat = await fs.stat(filePath).catch(() => null);
  let servePath = filePath;
  if (stat?.isDirectory()) {
    servePath = path.join(filePath, "index.html");
    stat = await fs.stat(servePath).catch(() => null);
  }
  if (!stat?.isFile() && !path.extname(filePath)) {
    // SPA history fallback for extensionless app routes (index.html only;
    // missing hashed assets keep their extension and hard-404).
    servePath = path.join(root, "index.html");
    stat = await fs.stat(servePath).catch(() => null);
  }
  if (!stat?.isFile()) {
    if (!missingLogged.has(pathname)) {
      missingLogged.add(pathname);
      if (missingLogged.size <= 200) {
        console.error(`[e2e-static-server] 404 ${pathname}`);
      } else {
        console.error("[e2e-static-server] 404 log cap reached");
      }
    }
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end("not found");
    return;
  }

  const type =
    MIME[path.extname(servePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": type,
    "Content-Length": stat.size,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(servePath).pipe(res);
}

server.listen(port, "127.0.0.1", () => {
  console.error(
    `[e2e-static-server] serving ${root} on http://127.0.0.1:${port} (no-store)`,
  );
});
